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

    // Include the last user message and message count to differentiate
    // conversations that share the same system prompt and opening message.
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUser = userMessages.length > 1 ? extractText(userMessages[userMessages.length - 1].content) : "";
    const msgCount = messages.length;

    const result = createHash('sha256').update(`${system.substring(0, 50)}:${firstUser.substring(0, 200)}:${lastUser.substring(0, 200)}:${msgCount}`).digest('hex').substring(0, 12);
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

    // 1. Tool Call ID Match (Deep Scan - Tool Results)
    // We scan the last few messages for tool results. If we find a tool result
    // that matches a pending tool call, we hijack that turn.
    const scanRange = messages.slice(-10);
    for (const msg of [...scanRange].reverse()) {
        if (msg.role === 'tool' || msg.role === 'function') {
            const callId = msg.tool_call_id;
            const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;

            if (shortKey) {
                for (const [callKey, pending] of pendingToolCalls.entries()) {
                    if (callKey.startsWith(shortKey)) {
                        hijackedTurnId = pending.turnId;
                        matchType = 'tool_call';
                        console.log(`[API] Hijack discovery: Match found via tool_id ${callId} -> Turn ${hijackedTurnId}`);
                        if (PERF_ENABLED) {
                            findHijackedTurnId._lastDurationMs = performance.now() - start;
                            findHijackedTurnId._pendingToolCallsSize = pendingToolCalls.size;
                        }
                        return { turnId: hijackedTurnId, matchType };
                    }
                }
            }
        }
    }

    // 2. Assistant Tool Call Match (Proxy Scan)
    // If the history ends with (or near) an assistant tool call that is in pendingToolCalls,
    // and the user just replied to it (or it's a retry), hijack it.
    for (const msg of [...scanRange].reverse()) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                const callId = tc.id || tc.tool_call_id;
                const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;
                if (shortKey) {
                    for (const [callKey, pending] of pendingToolCalls.entries()) {
                        if (callKey.startsWith(shortKey)) {
                            hijackedTurnId = pending.turnId;
                            matchType = 'assistant_tool_match';
                            console.log(`[API] Hijack discovery: Match found via assistant tool_call ${callId} -> Turn ${hijackedTurnId}`);
                            if (PERF_ENABLED) {
                                findHijackedTurnId._lastDurationMs = performance.now() - start;
                                findHijackedTurnId._pendingToolCallsSize = pendingToolCalls.size;
                            }
                            return { turnId: hijackedTurnId, matchType };
                        }
                    }
                }
            }
        }
    }

    // 3. Tool Content Match (Exact Args Fallback)
    // If we have an assistant tool call but no ID match, compare the hash of the 
    // tool name and arguments. This is the ultimate "exact form" check.
    for (const msg of [...scanRange].reverse()) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || tc.name;
                const rawArgs = tc.function?.arguments || tc.arguments || "{}";
                const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                
                // Note: We use the namespaced name matching logic if needed, 
                // but usually the bridge handles the 'mcp_io_' prefix.
                // We'll check both the raw name and the prefixed name for robustness.
                const namespacedName = `mcp_io_${toolName}`;

                const contentHash = createHash('sha256')
                    .update(`${toolName}:${argsStr}`)
                    .digest('hex')
                    .substring(0, 16);
                
                const namespacedHash = createHash('sha256')
                    .update(`${namespacedName}:${argsStr}`)
                    .digest('hex')
                    .substring(0, 16);

                for (const [callKey, pending] of pendingToolCalls.entries()) {
                    if (pending.contentHash === contentHash || pending.contentHash === namespacedHash) {
                        hijackedTurnId = pending.turnId;
                        matchType = 'tool_content_match';
                        console.log(`[API] Hijack discovery: Match found via tool content hash for ${toolName} -> Turn ${hijackedTurnId}`);
                        if (PERF_ENABLED) {
                            findHijackedTurnId._lastDurationMs = performance.now() - start;
                            findHijackedTurnId._pendingToolCallsSize = pendingToolCalls.size;
                        }
                        return { turnId: hijackedTurnId, matchType };
                    }
                }
            }
        }
    }

    // 4. Sliding History Match (Continuity Match)
    // If we can't match via tool IDs, we check if the current history (minus last message)
    // matches a previously active turn. This is extremely robust for simple continuations.
    if (messages.length > 1) {
        // Try matching history minus 1, 2, or 3 messages (to account for narrations/metadata)
        for (let i = 1; i <= 3 && messages.length > i; i++) {
            const subHistory = messages.slice(0, -i);
            const subHash = getHistoryHash(subHistory);
            const candidateTurnId = activeTurnsByHash.get(subHash);
            if (candidateTurnId && parkedTurns.has(candidateTurnId)) {
                hijackedTurnId = candidateTurnId;
                matchType = `history_parent_${i}`;
                console.log(`[HIJACK] Parent History Match (Offset ${i}): Turn ${hijackedTurnId}`);
                if (PERF_ENABLED) {
                    findHijackedTurnId._lastDurationMs = performance.now() - start;
                    findHijackedTurnId._pendingToolCallsSize = pendingToolCalls.size;
                }
                return { turnId: hijackedTurnId, matchType };
            }
        }
    }

    // 5. Hash/Fingerprint Match (Legacy/Retry)
    const byHash = activeTurnsByHash.get(historyHash);
    const byFinger = activeTurnsByHash.get(fingerprint);

    if (byHash) {
        hijackedTurnId = byHash;
        matchType = 'hash';
        console.log(`[HIJACK] Exact Hash Match (Thread Safe): Turn ${hijackedTurnId}`);
    } else if (byFinger && parkedTurns.has(byFinger)) {
        hijackedTurnId = byFinger;
        matchType = 'fingerprint_parked';
        console.log(`[HIJACK] Fingerprint Match (Parked Turn): Turn ${hijackedTurnId}`);
    } else if (byFinger) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function')) {
            hijackedTurnId = byFinger;
            matchType = 'fingerprint_tool';
            console.log(`[HIJACK] Fingerprint Anchor Match (Tool Continuation, Fallback): Turn ${hijackedTurnId}`);
        } else {
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

