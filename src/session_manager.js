import { createHash } from 'crypto';

/**
 * Computes a hash of the conversation messages to identify a thread.
 * Traditional hash is very sensitive.
 */
export const getHistoryHash = (messages) => {
    const serialized = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content, name: m.name, tool_call_id: m.tool_call_id })));
    return createHash('sha256').update(serialized).digest('hex');
};

/**
 * A more stable identifier that ignores slight metadata or "thinking" changes.
 * Useful for catching retries that might have slightly different history.
 */
export const getConversationFingerprint = (messages) => {
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

        // Drift Resistance: Try to isolate the core <user_message>
        const userMsgMatch = text.match(/<user_message>([\s\S]*?)<\/user_message>/);
        if (userMsgMatch) return userMsgMatch[1].trim();

        // Fallback: Strip known dynamic blocks like <environment_details>
        return text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "").trim();
    };

    const system = extractText(systemMsg?.content);
    const firstUser = extractText(firstUserMsg?.content);

    // Hash the purified content (first 500 chars)
    return createHash('sha256').update(`${system.substring(0, 100)}:${firstUser.substring(0, 500)}`).digest('hex').substring(0, 12);
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
 * @returns {string|null} - The ID of the turn to hijack, or null if none.
 */
export const findHijackedTurnId = (messages, historyHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls, debug = false) => {
    let hijackedTurnId = null;

    // 1. Tool Call ID Match (Deep Scan)
    // We scan the last few messages for tool results. If we find a tool result
    // that matches a pending tool call, we hijack that turn.
    // This is robust against history truncation and non-last-message scenarios.
    const scanRange = messages.slice(-10); // Check last 10 messages to be safe
    for (const msg of scanRange.reverse()) { // Reverse to prioritize recent
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
                        console.log(`[API] Hijack discovery: Match found for ${callId} -> Turn ${hijackedTurnId}`);
                        return hijackedTurnId; // Immediate return on strong match
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
        console.log(`[HIJACK] Exact Hash Match (Thread Safe): Turn ${hijackedTurnId}`);
    } else if (byFinger && parkedTurns.has(byFinger)) {
        // Priority: If the turn is already Parked, we MUST hijack it to deliver the next message (approval/data)
        hijackedTurnId = byFinger;
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
             console.log(`[HIJACK] Fingerprint Anchor Match (Tool Continuation, Fallback): Turn ${hijackedTurnId}`);
        } else {
            // New Instruction / Retry on active turn
             // This case is handled by the caller (Preemption/Cancellation) or Wait-and-Hijack logic
             // We return matching turn ID, caller decides what to do.
             hijackedTurnId = byFinger;
             if (debug) console.log(`[HIJACK] Fingerprint Match (Active/Unknown state): Turn ${hijackedTurnId}`);
        }
    }

    return hijackedTurnId;
};
