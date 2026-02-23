import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3102;
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
            API_KEY: 'test-compat-key',
            NODE_ENV: 'test'
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

test('API Compatibility Suite', async (t) => {

    await t.test('Setup Bridge', async () => {
        await startSharedBridge('text');
    });

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'test-compat-key',
        maxRetries: 0,
        timeout: 5000
    });

    await t.test('Accepts Standard OpenAI Parameters', async () => {
        // These parameters might be ignored by the bridge/CLI, but the API should accept them (200 OK)
        // and not crash or return 400.
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'test params' }],
            temperature: 0.7,
            top_p: 0.9,
            n: 1,
            stop: ['\n'],
            max_tokens: 100,
            presence_penalty: 0.5,
            frequency_penalty: 0.5,
            user: 'user-123',
            seed: 42
        });

        assert.ok(response.choices[0].message.content.includes('mock response'));
    });

    await t.test('Accepts response_format (JSON Mode)', async () => {
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'json please' }],
            response_format: { type: 'json_object' }
        });

        assert.ok(response.choices[0].message.content);
    });

    await t.test('Accepts logit_bias', async () => {
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'logit test' }],
            logit_bias: { "50256": -100 }
        });

        assert.ok(response.choices[0].message.content);
    });

    await t.test('Accepts multiple stop sequences', async () => {
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'stop test' }],
            stop: ['END', 'STOP']
        });

        assert.ok(response.choices[0].message.content);
    });

    await t.test('Teardown', async () => {
        await stopSharedBridge();
    });
});
