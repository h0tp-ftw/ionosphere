/**
 * test/jsonl_accumulator.test.js
 *
 * Unit tests for JsonlAccumulator — the JSONL line parser that reassembles
 * fragmented stdio chunks from the Gemini CLI process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonlAccumulator } from '../src/GeminiController.js';

// ─── Fragmentation ────────────────────────────────────────────────────────────

test('JsonlAccumulator - reassembles two objects split across chunks', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push('{"type":"init","session_id":"abc"}\n{"type":"');
    acc.push('message","role":"user","content":"hello"}\n');

    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, 'init');
    assert.equal(lines[0].session_id, 'abc');
    assert.equal(lines[1].type, 'message');
    assert.equal(lines[1].role, 'user');
});

test('JsonlAccumulator - handles extreme fragmentation (one byte at a time sim)', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    const raw = '{"type":"tool_use","tool_name":"fn","tool_id":"x","parameters":{}}\n';
    // Push in 5-char chunks
    for (let i = 0; i < raw.length; i += 5) {
        acc.push(raw.slice(i, i + 5));
    }

    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'tool_use');
    assert.equal(lines[0].tool_name, 'fn');
});

test('JsonlAccumulator - multiple objects in single chunk', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');

    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => l.type), ['a', 'b', 'c']);
});

// ─── Real CLI Event Types ─────────────────────────────────────────────────────

test('JsonlAccumulator - parses tool_use event correctly', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push(JSON.stringify({
        type: 'tool_use',
        timestamp: '2026-02-21T21:29:57.242Z',
        tool_name: 'resolve-library-id',
        tool_id: 'resolve-library-id-001',
        parameters: { query: 'openai', libraryName: 'openai' }
    }) + '\n');

    assert.equal(lines[0].type, 'tool_use');
    assert.equal(lines[0].tool_name, 'resolve-library-id');
    assert.equal(lines[0].tool_id, 'resolve-library-id-001');
    assert.deepEqual(lines[0].parameters, { query: 'openai', libraryName: 'openai' });
});

test('JsonlAccumulator - parses tool_result event correctly', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push(JSON.stringify({
        type: 'tool_result',
        tool_id: 'resolve-library-id-001',
        status: 'success',
        output: 'Library results...'
    }) + '\n');

    assert.equal(lines[0].type, 'tool_result');
    assert.equal(lines[0].status, 'success');
    assert.equal(lines[0].output, 'Library results...');
});

test('JsonlAccumulator - parses streaming message delta correctly', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'Hello world',
        delta: true
    }) + '\n');

    assert.equal(lines[0].type, 'message');
    assert.equal(lines[0].role, 'assistant');
    assert.equal(lines[0].content, 'Hello world');
    assert.equal(lines[0].delta, true);
});

test('JsonlAccumulator - parses result event with stats', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push(JSON.stringify({
        type: 'result',
        status: 'success',
        stats: { total_tokens: 34392, input_tokens: 32504, output_tokens: 746, duration_ms: 32949, tool_calls: 3 }
    }) + '\n');

    assert.equal(lines[0].type, 'result');
    assert.equal(lines[0].stats.total_tokens, 34392);
    assert.equal(lines[0].stats.output_tokens, 746);
    assert.equal(lines[0].stats.tool_calls, 3);
});

// ─── Robustness ───────────────────────────────────────────────────────────────

test('JsonlAccumulator - silently skips malformed JSON lines', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    const errors = [];
    acc.on('line', l => lines.push(l));

    // Simulate stderr noise interleaved
    acc.push('YOLO mode is enabled. All tool calls will be automatically approved.\n');
    acc.push('{"type":"message","role":"assistant","content":"ok","delta":true}\n');

    // Only the valid JSON line should be parsed
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'message');
});

test('JsonlAccumulator - ignores blank lines', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push('\n\n{"type":"done"}\n\n');

    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'done');
});

test('JsonlAccumulator - buffer is empty after all newlines consumed', () => {
    const acc = new JsonlAccumulator();
    acc.on('line', () => { });

    acc.push('{"type":"a"}\n{"type":"b"}\n');
    assert.equal(acc.buffer, '');
});

test('JsonlAccumulator - partial line remains in buffer until newline arrives', () => {
    const acc = new JsonlAccumulator();
    const lines = [];
    acc.on('line', l => lines.push(l));

    acc.push('{"type":"partial"');
    assert.equal(lines.length, 0);
    assert.ok(acc.buffer.includes('"partial"'));

    acc.push('}\n');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'partial');
});
