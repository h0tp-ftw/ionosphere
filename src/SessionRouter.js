import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SessionRouter — LCP-based Multi-Session Context Router
 *
 * Stateless AI clients (Roo Code, OpenClaw, etc.) send the ENTIRE conversation
 * history on every request. This module determines WHICH Gemini CLI session to
 * resume (or whether to create a new one) by comparing the incoming payload
 * against all known prior session payloads using the Longest Common Prefix (LCP)
 * algorithm.
 *
 * Decision Tree (at the first mismatch position n):
 *
 *   P[n] exists, S[n] does NOT  → CONTINUATION  (S is a prefix of P, resume S with delta)
 *   P[n] does NOT, S[n] exists  → SUBSET        (P is a prefix of S, SKIP — client may branch)
 *   Neither exist               → IDENTICAL      (exact match, no-op resume)
 *   Both exist                  → DIVERGENT      (different conversation, skip)
 *
 * Multi-session: pick the non-divergent candidate with the LONGEST LCP.
 * No match → create a new session.
 *
 * Complexity: O(K × M) where K = stored sessions, M = payload length.
 * 100% accurate — pure character comparison, no hashing.
 */
export class SessionRouter {
    /**
     * @param {string} persistPath - Absolute path to the SQLite DB file.
     */
    constructor(persistPath) {
        /** Path to the persistence database on disk. */
        this.persistPath = persistPath || path.join(process.cwd(), 'temp', 'sessions.db');

        const dir = path.dirname(this.persistPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Initialize built-in SQLite database
        this.db = new DatabaseSync(this.persistPath);

        // Define schema
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            )
        `);

        // Prepare statements for optimal performance
        this.stmtInsert = this.db.prepare('INSERT OR REPLACE INTO sessions (id, payload) VALUES (?, ?)');
        this.stmtSelectAll = this.db.prepare('SELECT id, payload FROM sessions');
        this.stmtDeleteAll = this.db.prepare('DELETE FROM sessions');
        this.stmtCount = this.db.prepare('SELECT COUNT(*) as count FROM sessions');

        const count = this.stmtCount.get().count;
        console.log(`[SessionRouter] SQLite DB initialized. Currently tracking ${count} sessions.`);
    }

    /**
     * Route an incoming payload to the best matching session.
     *
     * @param {string} incomingPayload - The full conversation text from the client.
     * @returns {{ sessionId: string|null, delta: string, isNew: boolean }}
     */
    route(incomingPayload) {
        const count = this.stmtCount.get().count;
        if (count === 0) {
            return { sessionId: null, delta: incomingPayload, isNew: true };
        }

        let bestSessionId = null;
        let bestLcpLength = -1;
        let bestVerdict = null;

        // Iterate over rows directly from SQLite (this avoids a gigantic JSON buffer in memory)
        for (const row of this.stmtSelectAll.all()) {
            const sessionId = row.id;
            const stored = row.payload;
            const incoming = incomingPayload;

            // --- LCP Walk ---
            const limit = Math.min(stored.length, incoming.length);
            let n = 0;
            while (n < limit && stored[n] === incoming[n]) {
                n++;
            }

            // --- Decision Tree at position n ---
            const pHasMore = n < incoming.length;
            const sHasMore = n < stored.length;

            if (pHasMore && sHasMore) {
                // DIVERGENT — both have content after the split point.
                continue;
            }

            if (!pHasMore && sHasMore) {
                // SUBSET — P is a prefix of S. Treat as a skip.
                continue;
            }

            // CONTINUATION or IDENTICAL — valid matches.
            if (n > bestLcpLength) {
                bestLcpLength = n;
                bestSessionId = sessionId;

                if (pHasMore && !sHasMore) {
                    bestVerdict = 'CONTINUATION';
                } else {
                    bestVerdict = 'IDENTICAL';
                }
            }
        }

        if (bestSessionId === null) {
            console.log(`[SessionRouter] No matching session found. Creating new session.`);
            return { sessionId: null, delta: incomingPayload, isNew: true };
        }

        // We fetch the chosen payload again implicitly via LCP length since we just need the remainder
        if (bestVerdict === 'CONTINUATION') {
            const delta = incomingPayload.slice(bestLcpLength).trim();
            console.log(`[SessionRouter] CONTINUATION match on session ${bestSessionId}. Stripped ${bestLcpLength} chars. Delta: ${delta.length} chars.`);
            return { sessionId: bestSessionId, delta, isNew: false };
        }

        // IDENTICAL
        console.warn(`[SessionRouter] IDENTICAL match on session ${bestSessionId}. Payload unchanged. No-op.`);
        return { sessionId: bestSessionId, delta: '', isNew: false };
    }

    /**
     * Record a completed turn. Updates the database record for the session.
     *
     * @param {string} sessionId - The CLI session ID.
     * @param {string} fullPayload - The full cumulative payload up to this point.
     */
    recordTurn(sessionId, fullPayload) {
        this.stmtInsert.run(sessionId, fullPayload);
    }

    /**
     * Register a brand new session after discovering its CLI-assigned ID.
     *
     * @param {string} sessionId - The CLI session ID.
     * @param {string} initialPayload - The initial payload that created this session.
     */
    registerSession(sessionId, initialPayload) {
        this.stmtInsert.run(sessionId, initialPayload);
        console.log(`[SessionRouter] Registered new session in SQLite: ${sessionId}`);
    }

    /**
     * Fully resets the router — clears all sessions from the database.
     */
    reset() {
        this.stmtDeleteAll.run();
        console.log(`[SessionRouter] Wiped all sessions from database.`);
    }
}
