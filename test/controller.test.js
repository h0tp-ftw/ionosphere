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
