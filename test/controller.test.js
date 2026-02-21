import test from 'node:test';
import assert from 'node:assert';
import { GeminiController, JsonlAccumulator } from '../src/GeminiController.js';
import fs from 'fs';
import path from 'path';

test('JsonlAccumulator - handles fragmented OS pipes', (t) => {
    const accumulator = new JsonlAccumulator();
    const results = [];

    accumulator.on('line', (json) => {
        results.push(json);
    });

    // Simulate fragmented pipe read
    accumulator.push('{"type":"te');
    accumulator.push('xt","value"');
    accumulator.push(':"hello"}\n{"typ');
    accumulator.push('e":"done"}\n');

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].type, 'text');
    assert.strictEqual(results[0].value, 'hello');
    assert.strictEqual(results[1].type, 'done');
});

test('GeminiController - File Injection creates @temp references', (t) => {
    const controller = new GeminiController();

    // Create dummy file
    const dummyPath = path.join(process.cwd(), 'dummy.txt');
    fs.writeFileSync(dummyPath, 'Hello');

    const injectedName = controller.injectFile(dummyPath);

    assert.ok(injectedName.startsWith('@'));
    assert.ok(injectedName.includes('dummy.txt'));

    // Clean up
    fs.unlinkSync(dummyPath);
});

test('GeminiController - in stateless mode (default), router is null', (t) => {
    delete process.env.SESSION_MODE;
    const controller = new GeminiController();
    assert.strictEqual(controller.router, null, "Router must be null in stateless mode");
    assert.strictEqual(controller.sessionMode, 'stateless');
});

test('GeminiController - in stateful mode, exposes a SessionRouter instance', (t) => {
    process.env.SESSION_MODE = 'stateful';
    const controller = new GeminiController();
    assert.ok(controller.router, "Controller must expose a SessionRouter in stateful mode");
    assert.strictEqual(typeof controller.router.route, 'function');
    assert.strictEqual(typeof controller.router.registerSession, 'function');
    assert.strictEqual(typeof controller.router.recordTurn, 'function');
    assert.strictEqual(controller.sessionMode, 'stateful');
    delete process.env.SESSION_MODE;
});

// ─── Real CLI event type routing ──────────────────────────────────────────────

test('JsonlAccumulator - tool_use event is parsed and fields are accessible', (t) => {
    const accumulator = new JsonlAccumulator();
    const toolUseEvents = [];

    accumulator.on('line', (json) => {
        if (json.type === 'tool_use') toolUseEvents.push(json);
    });

    // Real event format from CLI -o stream-json output
    accumulator.push(JSON.stringify({
        type: 'tool_use',
        timestamp: '2026-02-21T21:29:57.242Z',
        tool_name: 'resolve-library-id',
        tool_id: 'resolve-library-id-001',
        parameters: { query: 'openai', libraryName: 'openai' }
    }) + '\n');

    assert.strictEqual(toolUseEvents.length, 1);
    assert.strictEqual(toolUseEvents[0].tool_name, 'resolve-library-id');
    assert.strictEqual(toolUseEvents[0].tool_id, 'resolve-library-id-001');
    assert.deepStrictEqual(toolUseEvents[0].parameters, { query: 'openai', libraryName: 'openai' });
});

test('JsonlAccumulator - result event with stats is parsed with full stats block', (t) => {
    const accumulator = new JsonlAccumulator();
    const resultEvents = [];

    accumulator.on('line', (json) => {
        if (json.type === 'result') resultEvents.push(json);
    });

    // Real stats from live CLI run
    accumulator.push(JSON.stringify({
        type: 'result',
        status: 'success',
        stats: {
            total_tokens: 34392,
            input_tokens: 32504,
            output_tokens: 746,
            cached: 12426,
            duration_ms: 32949,
            tool_calls: 3
        }
    }) + '\n');

    assert.strictEqual(resultEvents.length, 1);
    assert.strictEqual(resultEvents[0].stats.total_tokens, 34392);
    assert.strictEqual(resultEvents[0].stats.output_tokens, 746);
    assert.strictEqual(resultEvents[0].stats.tool_calls, 3);
});

