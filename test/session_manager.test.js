import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { findHijackedTurnId, getHistoryHash, getConversationFingerprint } from '../src/session_manager.js';

describe('Session Manager Logic', () => {

    const turnId = 'turn-123';
    const activeTurnsByHash = new Map();
    const parkedTurns = new Map();
    const pendingToolCalls = new Map();
    let messages;
    let historyHash;
    let fingerprint;

    beforeEach(() => {
        activeTurnsByHash.clear();
        parkedTurns.clear();
        pendingToolCalls.clear();

        messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What time is it?' },
            { role: 'assistant', tool_calls: [{ id: 'call_abc12345', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }
        ];

        historyHash = getHistoryHash(messages);
        fingerprint = getConversationFingerprint(messages);
    });

    it('should identify hijack by exact hash match', () => {
        activeTurnsByHash.set(historyHash, turnId);

        const result = findHijackedTurnId(messages, historyHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.strictEqual(result, turnId);
    });

    it('should identify hijack by fingerprint match when parked', () => {
        activeTurnsByHash.set(fingerprint, turnId);
        parkedTurns.set(turnId, {}); // Mock parked turn

        const result = findHijackedTurnId(messages, 'different-hash', fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.strictEqual(result, turnId);
    });

    it('should identify hijack by tool call ID match (last message)', () => {
        const toolResultMsg = { role: 'tool', tool_call_id: 'call_abc12345', content: '12:00 PM' };
        const newMessages = [...messages, toolResultMsg];
        const newHash = getHistoryHash(newMessages);

        // Pending call matches the ID
        // The pendingToolCalls key is usually the full UUID
        // The helper checks if callKey.startsWith(shortKey)
        // shortKey is callId substring(5) -> abc12345
        pendingToolCalls.set('abc12345-some-uuid', { turnId: turnId });

        const result = findHijackedTurnId(newMessages, newHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.strictEqual(result, turnId);
    });

    it('should identify hijack by tool call ID match (NOT last message)', () => {
        const toolResultMsg = { role: 'tool', tool_call_id: 'call_abc12345', content: '12:00 PM' };
        const followUpMsg = { role: 'user', content: 'Thanks!' };
        const newMessages = [...messages, toolResultMsg, followUpMsg];
        const newHash = getHistoryHash(newMessages);

        pendingToolCalls.set('abc12345-some-uuid', { turnId: turnId });

        const result = findHijackedTurnId(newMessages, newHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.strictEqual(result, turnId);
    });

    it('should prioritize tool call ID match over fingerprint mismatch (truncation)', () => {
        // Simulate history truncation where fingerprint changes
        const truncatedMessages = [
            // System and first user message missing/changed
            { role: 'user', content: 'What time is it (again)?' },
            { role: 'assistant', tool_calls: [{ id: 'call_abc12345', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_abc12345', content: '12:00 PM' }
        ];

        // Ensure fingerprint is different
        const truncatedFingerprint = getConversationFingerprint(truncatedMessages);
        assert.notStrictEqual(truncatedFingerprint, fingerprint);

        pendingToolCalls.set('abc12345-some-uuid', { turnId: turnId });

        const result = findHijackedTurnId(truncatedMessages, 'hash', truncatedFingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.strictEqual(result, turnId);
    });

    it('should return null if no match found', () => {
        const result = findHijackedTurnId(messages, 'hash', 'fingerprint', activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.strictEqual(result, null);
    });

});
