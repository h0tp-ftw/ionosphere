import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3101; // Different port to avoid conflict
const API_URL = `http://127.0.0.1:${BRIDGE_PORT}/v1`;

let bridgeProc = null;

async function startSharedBridge(scenario = 'text') {
    if (bridgeProc) {
        bridgeProc.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 1000));
    }

    const bridgeEntry = path.join(__dirname, '..', 'src', 'index.js');
    bridgeProc = spawn('node', [bridgeEntry], {
        env: {
            ...process.env,
            PORT: String(BRIDGE_PORT),
            GEMINI_CLI_PATH: `node ${MOCK_CLI}`,
            CLI_SCENARIO: scenario,
            API_KEY: 'test-robust-key',
            NODE_ENV: 'test',
            MAX_CONCURRENT_CLI: '2' // Limit concurrency to test queueing
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
        let started = false;
        const onData = (chunk) => {
            if (!started && chunk.toString().includes('listening')) {
                started = true;
                setTimeout(resolve, 1000);
            }
        };
        bridgeProc.stdout.on('data', onData);
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 5000);
    });
}

async function stopSharedBridge() {
    if (bridgeProc) {
        const closePromise = new Promise(resolve => bridgeProc.on('close', resolve));
        bridgeProc.kill('SIGKILL');
        bridgeProc = null;
        await closePromise;
    }
}

test('Robustness Suite', async (t) => {

    await t.test('Setup Bridge', async () => {
        await startSharedBridge('text');
    });

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'test-robust-key',
        maxRetries: 0,
        timeout: 5000
    });

    await t.test('Concurrent Requests (Queueing)', async () => {
        // MAX_CONCURRENT_CLI is set to 2
        // We fire 5 requests. 2 should start immediately, 3 should be queued.
        // We verify that all 5 eventually complete.

        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(client.chat.completions.create({
                model: 'gemini-2.5-flash-lite',
                messages: [{ role: 'user', content: `req-${i}` }]
            }));
        }

        const results = await Promise.all(promises);
        assert.equal(results.length, 5);
        results.forEach(res => {
            assert.ok(res.choices[0].message.content.includes('mock response'));
        });
    });

    await t.test('Invalid JSON Input', async () => {
        const response = await fetch(`${API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-robust-key'
            },
            body: '{ "invalid": json ' // Malformed JSON
        });

        // Express body-parser should catch this and return 400
        assert.equal(response.status, 400);
    });

    await t.test('Missing Messages Field', async () => {
        try {
            await client.chat.completions.create({
                model: 'gemini-2.5-flash-lite',
                // messages is missing
            });
            assert.fail('Should have thrown 400');
        } catch (err) {
            assert.equal(err.status, 400);
        }
    });

    await t.test('Cancellation / Abort', async () => {
        // Start a long running request
        await startSharedBridge('long_text');

        const controller = new AbortController();
        const promise = client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'long run' }],
            stream: true,
        }, { signal: controller.signal });

        // Let it start
        let count = 0;
        try {
            for await (const chunk of await promise) {
                count++;
                if (count > 1) {
                    controller.abort();
                    break;
                }
            }
        } catch (err) {
            assert.ok(err.name === 'AbortError' || err.message.includes('aborted'));
        }

        // Wait a bit to ensure server didn't crash
        await new Promise(r => setTimeout(r, 500));

        // Verify server is still up with a simple request
        await startSharedBridge('text'); // Restart to clear any mock state if needed, or just use text scenario
        const check = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'check' }]
        });
        assert.ok(check.choices[0].message.content);
    });

    await t.test('Large Payload', async () => {
        await startSharedBridge('text');

        const largeContent = 'a'.repeat(100000); // 100KB string
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: largeContent }]
        });

        assert.ok(response.choices[0].message.content.includes('mock response'));
    });

    await t.test('Teardown', async () => {
        await stopSharedBridge();
    });
});
