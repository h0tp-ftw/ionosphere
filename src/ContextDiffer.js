/**
 * ContextDiffer — Longest Common Prefix (LCP) Context Stripper
 *
 * Stateless AI clients (Roo Code, OpenClaw, etc.) send the ENTIRE conversation
 * history on every request. The stateful Gemini CLI already retains that history
 * in its process memory. If we naively piped the full payload, the CLI would
 * see the entire prior conversation replayed as a new input.
 *
 * This module stores the **last full incoming payload** as its comparison baseline.
 * When a new payload arrives, it computes the Longest Common Prefix between the
 * new payload and the last one. The delta — everything after the shared prefix —
 * is the actual new content.
 *
 * Algorithm (Longest Common Prefix / LCP):
 *   1. Walk character-by-character comparing newPayload[i] to lastPayload[i].
 *   2. Stop at the first mismatch at position n: that is the "split point".
 *   3. The delta is newPayload.slice(n).trim().
 *   4. If the new payload is a pure extension of the last (no mismatch up to
 *      lastPayload.length), the split point is lastPayload.length.
 *      This implements the user's rule: "if the condition is never met, pick
 *      based on recency" — i.e., take everything after the last known payload.
 *   5. The new full payload becomes the new baseline for next comparison.
 *
 * Activation Guard:
 *   The diffing engine ONLY activates after the first complete round-trip
 *   (one prompt sent + one `result` received). Before that, the client cannot
 *   have accumulated stale context to strip.
 */
export class ContextDiffer {
    constructor() {
        /** The full raw payload that was sent in the immediately prior turn. */
        this.lastPayload = '';

        /** Whether at least one full round-trip has completed. */
        this.hasCompletedFirstTurn = false;
    }

    /**
     * Called by GeminiController after a `result` event to mark the end of
     * a round-trip. After this, the next call to extractDelta will activate
     * the LCP diffing logic.
     */
    recordResponse() {
        this.hasCompletedFirstTurn = true;
    }

    /**
     * Computes the novel delta between the incoming payload and the last known
     * payload, then stores the new payload as the baseline for next time.
     *
     * @param {string} incomingPayload - The raw text from the HTTP request.
     * @returns {string} The stripped delta to pipe to the CLI.
     */
    extractDelta(incomingPayload) {
        // Pre-activation: no prior payload to compare against, pass through unchanged.
        if (!this.hasCompletedFirstTurn || this.lastPayload.length === 0) {
            this.lastPayload = incomingPayload;
            return incomingPayload;
        }

        const last = this.lastPayload;
        const next = incomingPayload;

        // --- LCP Walk ---
        // Walk character-by-character to find where the two strings first differ.
        const limit = Math.min(last.length, next.length);
        let splitPoint = 0;

        while (splitPoint < limit && last[splitPoint] === next[splitPoint]) {
            splitPoint++;
        }

        // If the entire last payload is a prefix of the new payload (standard
        // extension case), split at the end of the last payload.
        if (splitPoint === last.length) {
            const delta = next.slice(last.length).trim();
            this.lastPayload = next;
            if (delta) {
                console.log(`[ContextDiffer] Stripped ${last.length} chars of prior context. Delta: ${delta.length} chars.`);
            } else {
                console.warn(`[ContextDiffer] Delta was empty — payload is identical to last sent.`);
            }
            return delta;
        }

        // Partial mismatch — the payload diverged from the last known payload.
        // The client may have rewritten a prior message. We trust the new payload
        // from the split point onward as the new intent.
        const delta = next.slice(splitPoint).trim();
        console.warn(`[ContextDiffer] Context diverged at char ${splitPoint}. Rebinding baseline. Delta: ${delta.length} chars.`);
        this.lastPayload = next;
        return delta;
    }

    /**
     * Fully resets the differ — call this if the session is intentionally restarted.
     */
    reset() {
        this.lastPayload = '';
        this.hasCompletedFirstTurn = false;
    }
}
