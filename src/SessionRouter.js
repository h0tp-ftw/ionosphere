import fs from 'fs';
import path from 'path';

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
     * @param {string} persistPath - Absolute path to the JSON file used for disk persistence.
     */
    constructor(persistPath) {
        /**
         * Map of sessionId → { payload: string }
         * @type {Map<string, { payload: string }>}
         */
        this.sessions = new Map();

        /** Path to the persistence file on disk. */
        this.persistPath = persistPath || path.join(process.cwd(), 'temp', 'sessions.json');

        this.loadFromDisk();
    }

    /**
     * Route an incoming payload to the best matching session.
     *
     * @param {string} incomingPayload - The full conversation text from the client.
     * @returns {{ sessionId: string|null, delta: string, isNew: boolean }}
     */
    route(incomingPayload) {
        if (this.sessions.size === 0) {
            return { sessionId: null, delta: incomingPayload, isNew: true };
        }

        let bestSessionId = null;
        let bestLcpLength = -1;
        let bestVerdict = null;

        for (const [sessionId, session] of this.sessions) {
            const stored = session.payload;
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
                // This is a different conversation. Skip.
                continue;
            }

            if (!pHasMore && sHasMore) {
                // SUBSET — P is a prefix of S. The client sent less history
                // than the stored session has. This means the client may be
                // branching from an earlier point, so we must NOT resume S.
                // Treat as a skip (the client's next message could diverge).
                continue;
            }

            // CONTINUATION or IDENTICAL — valid matches.
            // Pick the one with the longest overlap.
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
            // All sessions diverged. Start a new conversation.
            console.log(`[SessionRouter] No matching session found. Creating new session.`);
            return { sessionId: null, delta: incomingPayload, isNew: true };
        }

        const stored = this.sessions.get(bestSessionId).payload;

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
     * Record a completed turn. Updates the stored payload for the session.
     * Call this AFTER a successful round-trip so the next route() has the
     * correct baseline.
     *
     * @param {string} sessionId - The CLI session ID.
     * @param {string} fullPayload - The full cumulative payload up to this point.
     */
    recordTurn(sessionId, fullPayload) {
        this.sessions.set(sessionId, { payload: fullPayload });
        this.persistToDisk();
    }

    /**
     * Register a brand new session after discovering its CLI-assigned ID.
     *
     * @param {string} sessionId - The CLI session ID.
     * @param {string} initialPayload - The initial payload that created this session.
     */
    registerSession(sessionId, initialPayload) {
        this.sessions.set(sessionId, { payload: initialPayload });
        this.persistToDisk();
        console.log(`[SessionRouter] Registered new session: ${sessionId}`);
    }

    /**
     * Serialize the session map to disk as JSON.
     */
    persistToDisk() {
        try {
            const dir = path.dirname(this.persistPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const serialized = {};
            for (const [id, data] of this.sessions) {
                serialized[id] = data;
            }
            fs.writeFileSync(this.persistPath, JSON.stringify(serialized, null, 2), 'utf-8');
        } catch (err) {
            console.error(`[SessionRouter] Failed to persist sessions to disk:`, err);
        }
    }

    /**
     * Load the session map from disk.
     */
    loadFromDisk() {
        try {
            if (fs.existsSync(this.persistPath)) {
                const raw = fs.readFileSync(this.persistPath, 'utf-8');
                const parsed = JSON.parse(raw);
                for (const [id, data] of Object.entries(parsed)) {
                    this.sessions.set(id, data);
                }
                console.log(`[SessionRouter] Loaded ${this.sessions.size} sessions from disk.`);
            }
        } catch (err) {
            console.error(`[SessionRouter] Failed to load sessions from disk:`, err);
        }
    }

    /**
     * Fully resets the router — clears all sessions and removes the persistence file.
     */
    reset() {
        this.sessions.clear();
        try {
            if (fs.existsSync(this.persistPath)) {
                fs.unlinkSync(this.persistPath);
            }
        } catch (err) {
            console.error(`[SessionRouter] Failed to delete persistence file:`, err);
        }
    }
}
