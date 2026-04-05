import { createHash } from 'crypto';
import { performance } from 'perf_hooks';

const PERF_ENABLED = process.env.GEMINI_PERF_TIMING === 'true';

/**
 * Computes a hash of the conversation messages to identify a thread.
 * Traditional hash is very sensitive.
 */
export const getHistoryHash = (messages) => {
    const start = PERF_ENABLED ? performance.now() : 0;
    const serialized = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content, name: m.name, tool_call_id: m.tool_call_id })));
    const result = createHash('sha256').update(serialized).digest('hex');
    if (PERF_ENABLED) {
        getHistoryHash._lastDurationMs = performance.now() - start;
        getHistoryHash._lastInputSize = serialized.length;
    }
    return result;
};

/**
 * A more stable identifier that ignores slight metadata or "thinking" changes.
 * Useful for catching retries that might have slightly different history.
 */
export const getConversationFingerprint = (messages) => {
    const start = PERF_ENABLED ? performance.now() : 0;
    // Stable Turn Anchor: based on the FIRST user message and system prompt
    // This is more resilient to history truncation/sliding windows.
    const systemMsg = messages.find(m => m.role === 'system');

    // Find the FIRST user message
    const firstUserMsg = messages.find(m => m.role === 'user');

    const extractText = (content) => {
        if (!content) return "";
        let text = "";
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
            text = content.map(p => (typeof p === 'object' && p.type === 'text') ? p.text : "").join("");
        }

        // Use the text as-is for fingerprinting (normalization follows)
        // (Legacy XML tag stripping removed)

        // Normalization: Remove all non-alphanumeric for fingerprint anchor
        return text.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    };

    const system = extractText(systemMsg?.content);
    const firstUser = extractText(firstUserMsg?.content);

    // Hash the purified content (first 500 chars)
    const result = createHash('sha256').update(`${system.substring(0, 50)}:${firstUser.substring(0, 200)}`).digest('hex').substring(0, 12);
    if (PERF_ENABLED) {
        getConversationFingerprint._lastDurationMs = performance.now() - start;
    }
    return result;
};

/**
 * Logic to identify if there is an existing session (turn) that should be hijacked.
 *
 * @param {Array} messages - The full message history.
 * @param {string} historyHash - The calculated hash of the history.
 * @param {string} fingerprint - The calculated fingerprint of the conversation.
 * @param {Map} activeTurnsByHash - Map of active turns by hash/fingerprint.
 * @param {Map} parkedTurns - Map of currently parked turns.
 * @param {Map} pendingToolCalls - Map of pending tool calls.
 * @param {boolean} debug - Enable debug logging.
 *
 * @returns {object|null} - An object { turnId, matchType } or null if none.
 */
export const findHijackedTurnId = (messages, historyHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls, debug = false) => {
    const start = PERF_ENABLED ? performance.now() : 0;
    let hijackedTurnId = null;
    let matchType = null;

    // 1. Tool Call ID Match (Deep Scan)
    // We scan the last few messages for tool results. If we find a tool result
    // that matches a pending tool call, we hijack that turn.
    // This is robust against history truncation and non-last-message scenarios.
    const scanRange = messages.slice(-10); // Check last 10 messages to be safe
    for (const msg of [...scanRange].reverse()) { // Reverse to prioritize recent
        if (msg.role === 'tool' || msg.role === 'function') {
            const callId = msg.tool_call_id;
            const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;

            if (shortKey) {
                if (debug) {
                    console.log(`[Handoff] Deep-scan checking callId: ${callId} (short: ${shortKey})`);
                }

                // Find the full callKey in pendingToolCalls
                for (const [callKey, pending] of pendingToolCalls.entries()) {
                    if (callKey.startsWith(shortKey)) {
                        hijackedTurnId = pending.turnId;
                        matchType = 'tool_call';
                        console.log(`[API] Hijack discovery: Match found for ${callId} -> Turn ${hijackedTurnId}`);
                        if (PERF_ENABLED) {
                            findHijackedTurnId._lastDurationMs = performance.now() - start;
                            findHijackedTurnId._pendingToolCallsSize = pendingToolCalls.size;
                        }
                        return { turnId: hijackedTurnId, matchType }; // Immediate return on strong match
                    }
                }
            }
        }
    }

    // 2. Hash/Fingerprint Match
    const byHash = activeTurnsByHash.get(historyHash);
    const byFinger = activeTurnsByHash.get(fingerprint);

    if (byHash) {
        hijackedTurnId = byHash;
        matchType = 'hash';
        console.log(`[HIJACK] Exact Hash Match (Thread Safe): Turn ${hijackedTurnId}`);
    } else if (byFinger && parkedTurns.has(byFinger)) {
        // Priority: If the turn is already Parked, we MUST hijack it to deliver the next message (approval/data)
        hijackedTurnId = byFinger;
        matchType = 'fingerprint_parked';
        console.log(`[HIJACK] Fingerprint Match (Parked Turn): Turn ${hijackedTurnId}`);
    } else if (byFinger) {
        // We have a fingerprint match, but it's not parked.
        // It might be a tool continuation where the history changed (so hash mismatch),
        // but since we didn't find a tool call match in step 1,
        // this is likely a NEW instruction or a retry on an active turn.

        // We check if the LAST message is a tool result. If so, we might have missed it in pendingToolCalls
        // (e.g. server restart lost state), but we should try to attach to the fingerprinted turn
        // if it's the same conversation.
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function')) {
            hijackedTurnId = byFinger;
            matchType = 'fingerprint_tool';
            console.log(`[HIJACK] Fingerprint Anchor Match (Tool Continuation, Fallback): Turn ${hijackedTurnId}`);
        } else {
            // New Instruction / Retry on active turn
            // This case is handled by the caller (Preemption/Cancellation) or Wait-and-Hijack logic
            // We return matching turn ID, caller decides what to do.
            hijackedTurnId = byFinger;
            matchType = 'fingerprint_active';
            if (debug) console.log(`[HIJACK] Fingerprint Match (Active/Unknown state): Turn ${hijackedTurnId}`);
        }
    }

    if (PERF_ENABLED) {
        findHijackedTurnId._lastDurationMs = performance.now() - start;
        findHijackedTurnId._pendingToolCallsSize = pendingToolCalls.size;
    }

    if (hijackedTurnId) {
        return { turnId: hijackedTurnId, matchType };
    }

    return null;
};
