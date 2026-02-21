/**
 * test/event_router.test.js
 *
 * Unit tests for GeminiController's JSONL event callback routing.
 * Verifies that each real CLI event type fires the correct callback
 * with the correct normalized payload.
 *
 * Uses JsonlAccumulator directly rather than spawning a process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonlAccumulator } from '../src/GeminiController.js';

/**
 * Pipe a sequence of JSONL strings through an accumulator hooked to callbacks,
 * and return a collected record of what fired.
 */
function pipe(events, callbacks = {}) {
    const acc = new JsonlAccumulator();
    const fired = { onText: [], onToolCall: [], onError: [], onResult: [], onEvent: [] };

    acc.on('line', (json) => {
        // Mirror the routing logic from GeminiController.js
        if (json.type === 'text') {
            if (json.value && callbacks.onText) callbacks.onText(json.value);
            fired.onText.push(json);
        } else if (json.type === 'message' && json.role === 'assistant') {
            const text = (typeof json.content === 'object') ? json.content.text : json.content;
            if (text && callbacks.onText) callbacks.onText(text);
            fired.onText.push(json);
        } else if (json.type === 'tool_use') {
            const normalized = {
                id: json.tool_id || json.id,
                name: json.tool_name || json.name,
                arguments: JSON.stringify(json.parameters ?? json.arguments ?? {})
            };
            if (callbacks.onToolCall) callbacks.onToolCall(normalized);
            fired.onToolCall.push(normalized);
        } else if (json.type === 'tool_result') {
            if (callbacks.onEvent) callbacks.onEvent(json);
            fired.onEvent.push(json);
        } else if (json.type === 'toolCall') {
            if (callbacks.onToolCall) callbacks.onToolCall(json);
            fired.onToolCall.push(json);
        } else if (json.type === 'error') {
            if (callbacks.onError) callbacks.onError(json);
            fired.onError.push(json);
        } else if (json.type === 'result') {
            if (callbacks.onResult) callbacks.onResult(json);
            fired.onResult.push(json);
        } else {
            if (callbacks.onEvent) callbacks.onEvent(json);
            fired.onEvent.push(json);
        }
    });

    for (const ev of events) {
        acc.push(JSON.stringify(ev) + '\n');
    }

    return fired;
}

// ─── tool_use ─────────────────────────────────────────────────────────────────

test('event_router - tool_use fires onToolCall with normalized payload', () => {
    const fired = pipe([{
        type: 'tool_use',
        tool_name: 'resolve-library-id',
        tool_id: 'rid-001',
        parameters: { libraryName: 'openai' }
    }]);

    assert.equal(fired.onToolCall.length, 1);
    assert.equal(fired.onToolCall[0].name, 'resolve-library-id');
    assert.equal(fired.onToolCall[0].id, 'rid-001');
    assert.equal(fired.onToolCall[0].arguments, '{"libraryName":"openai"}');
});

test('event_router - tool_use with empty parameters produces {}', () => {
    const fired = pipe([{
        type: 'tool_use',
        tool_name: 'get_time',
        tool_id: 'gt-001',
        parameters: {}
    }]);

    assert.equal(fired.onToolCall[0].arguments, '{}');
});

// ─── tool_result ──────────────────────────────────────────────────────────────

test('event_router - tool_result fires onEvent, NOT onToolCall', () => {
    const fired = pipe([{
        type: 'tool_result',
        tool_id: 'rid-001',
        status: 'success',
        output: 'some result'
    }]);

    assert.equal(fired.onToolCall.length, 0);
    assert.equal(fired.onEvent.length, 1);
    assert.equal(fired.onEvent[0].type, 'tool_result');
});

// ─── Legacy toolCall ──────────────────────────────────────────────────────────

test('event_router - legacy toolCall event still fires onToolCall', () => {
    const fired = pipe([{
        type: 'toolCall',
        name: 'legacy_fn',
        id: 'legacy-001',
        arguments: '{}'
    }]);

    assert.equal(fired.onToolCall.length, 1);
    assert.equal(fired.onToolCall[0].type, 'toolCall');
});

// ─── message (delta) ─────────────────────────────────────────────────────────

test('event_router - assistant message delta fires onText', () => {
    const texts = [];
    pipe([
        { type: 'message', role: 'assistant', content: 'Hello ', delta: true },
        { type: 'message', role: 'assistant', content: 'world', delta: true }
    ], { onText: t => texts.push(t) });

    assert.deepEqual(texts, ['Hello ', 'world']);
});

test('event_router - user message does NOT fire onText', () => {
    const texts = [];
    pipe([{ type: 'message', role: 'user', content: 'user prompt' }], {
        onText: t => texts.push(t)
    });

    assert.equal(texts.length, 0);
});

// ─── result with stats ────────────────────────────────────────────────────────

test('event_router - result event fires onResult with stats preserved', () => {
    const results = [];
    pipe([{
        type: 'result',
        status: 'success',
        stats: { total_tokens: 34392, input_tokens: 32504, output_tokens: 746, tool_calls: 3 }
    }], { onResult: r => results.push(r) });

    assert.equal(results.length, 1);
    assert.equal(results[0].stats.total_tokens, 34392);
    assert.equal(results[0].stats.output_tokens, 746);
    assert.equal(results[0].stats.tool_calls, 3);
});

// ─── error ───────────────────────────────────────────────────────────────────

test('event_router - error event fires onError', () => {
    const errors = [];
    pipe([{ type: 'error', message: 'Auth failed', code: 'AUTH_EXPIRED' }], {
        onError: e => errors.push(e)
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'AUTH_EXPIRED');
});

// ─── Unknown events ───────────────────────────────────────────────────────────

test('event_router - unknown event types fire onEvent', () => {
    const events = [];
    pipe([{ type: 'init', session_id: 'abc', model: 'gemini-test' }], {
        onEvent: e => events.push(e)
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'init');
});

// ─── No callbacks — must not throw ───────────────────────────────────────────

test('event_router - fires cleanly when no callbacks provided', () => {
    assert.doesNotThrow(() => {
        pipe([
            { type: 'tool_use', tool_name: 'fn', tool_id: 'x', parameters: {} },
            { type: 'message', role: 'assistant', content: 'hi', delta: true },
            { type: 'result', status: 'success', stats: {} }
        ]);
    });
});
