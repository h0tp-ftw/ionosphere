import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { findHijackedTurnId, getHistoryHash, getConversationFingerprint } from '../src/session_manager.js';
import { createHash } from 'crypto';

describe('Enhanced Session Manager Logic', () => {

    const turnId = 'turn-enhanced-123';
    const activeTurnsByHash = new Map();
    const parkedTurns = new Map();
    const pendingToolCalls = new Map();
    let messages;

    beforeEach(() => {
        activeTurnsByHash.clear();
        parkedTurns.clear();
        pendingToolCalls.clear();

        messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What time is it?' },
            { role: 'assistant', tool_calls: [{ id: 'call_abc12345', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } }] }
        ];
    });

    it('should identify hijack via assistant tool call match (No tool result yet)', () => {
        // Model called a tool, but user just replied without a formal tool result
        const replyMessages = [...messages, { role: 'user', content: 'Actually, nevermind.' }];
        
        // Register the pending tool call
        pendingToolCalls.set('abc12345-uuid', { turnId: turnId });
        parkedTurns.set(turnId, {});

        const result = findHijackedTurnId(replyMessages, 'new-hash', 'fingerprint', activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.deepStrictEqual(result, { turnId, matchType: 'assistant_tool_match' });
    });

    it('should identify hijack via tool content hash (ID-less match)', () => {
        const toolName = 'get_time';
        const args = '{"zone":"UTC"}';
        const contentHash = createHash('sha256').update(`${toolName}:${args}`).digest('hex').substring(0, 16);

        // Client changed the ID but kept the content
        const modifiedMessages = [
            { role: 'system', content: '...' },
            { role: 'user', content: '...' },
            { role: 'assistant', tool_calls: [{ id: 'NEW_ID_999', type: 'function', function: { name: toolName, arguments: args } }] }
        ];

        pendingToolCalls.set('original-uuid', { turnId: turnId, name: toolName, contentHash: contentHash });
        parkedTurns.set(turnId, {});

        const result = findHijackedTurnId(modifiedMessages, 'hash', 'fingerprint', activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.deepStrictEqual(result, { turnId, matchType: 'tool_content_match' });
    });

    it('should identify hijack via sliding history match (Parent Hash)', () => {
        const historyHash = getHistoryHash(messages);
        activeTurnsByHash.set(historyHash, turnId);
        parkedTurns.set(turnId, {});

        // New request = Old history + New user message
        const nextRequestMessages = [...messages, { role: 'user', content: 'Hello?' }];
        const nextHash = getHistoryHash(nextRequestMessages);

        const result = findHijackedTurnId(nextRequestMessages, nextHash, 'different-fingerprint', activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.deepStrictEqual(result, { turnId, matchType: 'history_parent_1' });
    });

    it('should support sliding history match up to offset 3', () => {
        const historyHash = getHistoryHash(messages);
        activeTurnsByHash.set(historyHash, turnId);
        parkedTurns.set(turnId, {});

        // New request has 3 extra messages since the park
        const multiStepMessages = [
            ...messages, 
            { role: 'user', content: 'Wait...' },
            { role: 'assistant', content: 'Yes?' },
            { role: 'user', content: 'Actually, do X.' }
        ];
        const nextHash = getHistoryHash(multiStepMessages);

        const result = findHijackedTurnId(multiStepMessages, nextHash, 'finger', activeTurnsByHash, parkedTurns, pendingToolCalls);
        assert.deepStrictEqual(result, { turnId, matchType: 'history_parent_3' });
    });

});
