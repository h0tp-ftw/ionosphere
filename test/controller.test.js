import test from 'node:test';
import assert from 'node:assert';
import { GeminiController } from '../src/GeminiController.js';
import fs from 'fs';
import path from 'path';

test('GeminiController - JSONL Accumulator handles fragmented OS pipes', (t) => {
    const controller = new GeminiController();
    const results = [];

    controller.accumulator.on('line', (json) => {
        results.push(json);
    });

    // Simulate fragmented pipe read
    controller.accumulator.push('{"type":"te');
    controller.accumulator.push('xt","value"');
    controller.accumulator.push(':"hello"}\n{"typ');
    controller.accumulator.push('e":"done"}\n');

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].type, 'text');
    assert.strictEqual(results[0].value, 'hello');
    assert.strictEqual(results[1].type, 'done');
});

test('GeminiController - Mutex Queue avoids overlapping prompts', async (t) => {
    const controller = new GeminiController();

    // Mock the child process
    let writtenToStdin = 0;
    controller.process = {
        stdin: {
            write: (chunk) => {
                writtenToStdin++;
            }
        },
        kill: () => { },
        on: () => { }
    };

    // Send Prompt 1
    controller.sendPrompt("Prompt 1");
    // Send Prompt 2 immediately (should await Mutex)
    controller.sendPrompt("Prompt 2");

    // Give Promise resolution a microtask tick for Prompt 1 to hit the queue
    await new Promise(r => setTimeout(r, 20));

    // Because Prompt 1 hasn't emitted "done", Prompt 2 should be queued
    assert.strictEqual(writtenToStdin, 1, "Only the first prompt should hit stdin due to Mutex");

    // Simulate CLI finishing Prompt 1
    controller._onLine({ type: 'result' });

    // Give Promise resolution a microtask tick for Prompt 2
    await new Promise(r => setTimeout(r, 20));

    // Now Prompt 2 should have fired
    assert.strictEqual(writtenToStdin, 2, "Second prompt hit stdin after Mutex released");

    // Clean up Prompt 2 so the test exits cleanly and doesn't leave an active timeout
    controller._onLine({ type: 'result' });
});

test('GeminiController - File Injection creates @temp references', (t) => {
    const controller = new GeminiController();

    // Create dummy file
    const dummyPath = path.join(process.cwd(), 'dummy.txt');
    fs.writeFileSync(dummyPath, 'Hello');

    const injectedName = controller.injectFile(dummyPath);

    assert.ok(injectedName.startsWith('@'));
    assert.ok(injectedName.includes('dummy.txt'));
    assert.strictEqual(controller.currentPromptFiles.length, 1);

    // Clean up
    fs.unlinkSync(dummyPath);
    controller.currentPromptFiles = [];
});
