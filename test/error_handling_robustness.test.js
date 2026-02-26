import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3106;
const API_URL = `http://127.0.0.1:${BRIDGE_PORT}/v1`;

let bridgeProc = null;

async function startBridge(scenario) {
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
            API_KEY: 'error-key',
            NODE_ENV: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
        let started = false;
        bridgeProc.stdout.on('data', (chunk) => {
            const msg = chunk.toString();
            if (!started && (msg.includes('listening') || msg.includes('Starting Gemini'))) {
                started = true;
                setTimeout(resolve, 1000);
            }
        });
        bridgeProc.stderr.on('data', (chunk) => {
            console.error(`[Bridge Error] ${chunk}`);
        });
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 10000);
    });
}

test('Error Handling Robustness Suite', async (t) => {

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'error-key',
        maxRetries: 0
    });

    await t.test('CLI Crash Diagnostics', async () => {
        await startBridge('crash');
        try {
            await client.chat.completions.create({
                model: 'gemini-2.0-flash',
                messages: [{ role: 'user', content: 'crash me' }]
            });
            assert.fail('Should have failed');
        } catch (err) {
            assert.equal(err.status, 500);
            assert.ok(err.message.includes('SEGFAULT') || err.message.includes('Simulated crash'));
        }
    });

    await t.test('Auth Error (401)', async () => {
        await startBridge('auth_error');
        try {
            await client.chat.completions.create({
                model: 'gemini-2.0-flash',
                messages: [{ role: 'user', content: 'auth' }]
            });
            assert.fail('Should have failed');
        } catch (err) {
            assert.equal(err.status, 401);
            assert.ok(err.message.includes('Auth Expired'));
        }
    });

    await t.test('False Auth Error (Path containing "auth")', async () => {
        await startBridge('false_auth_path');
        try {
            await client.chat.completions.create({
                model: 'gemini-2.0-flash',
                messages: [{ role: 'user', content: 'false auth' }]
            });
            assert.fail('Should have failed');
        } catch (err) {
            // Should NOT be 401
            assert.equal(err.status, 500);
            assert.ok(err.message.includes('CLI failed'));
            assert.ok(err.message.includes('google-gemini-cli-auth'));
        }
    });

    await t.test('Quota Error (429)', async () => {
        await startBridge('quota_error');
        try {
            await client.chat.completions.create({
                model: 'gemini-2.0-flash',
                messages: [{ role: 'user', content: 'quota' }]
            });
            assert.fail('Should have failed');
        } catch (err) {
            assert.equal(err.status, 429);
            assert.ok(err.message.includes('Quota/Capacity Exhausted'));
        }
    });

    await t.test('Teardown', async () => {
        if (bridgeProc) bridgeProc.kill('SIGKILL');
    });
});
