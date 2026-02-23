import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3105;
const API_URL = `http://127.0.0.1:${BRIDGE_PORT}/v1`;

let bridgeProc = null;

async function startBridge(scenario = 'tool_park') {
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
            API_KEY: 'handoff-key',
            NODE_ENV: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
        let started = false;
        bridgeProc.stdout.on('data', (chunk) => {
            if (!started && chunk.toString().includes('listening')) {
                started = true;
                setTimeout(resolve, 500);
            }
        });
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 5000);
    });
}

test('Handoff Robustness Suite', async (t) => {

    await t.test('Setup', async () => {
        await startBridge('tool_park');
    });

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'handoff-key',
        maxRetries: 0
    });

    await t.test('Session Hijacking with History Drift', async () => {
        // 1. Initial request that triggers a tool park
        const messages = [
            { role: 'system', content: 'You are an engineer.' },
            { role: 'user', content: 'Scan the project.' }
        ];

        console.log("Filing initial request...");
        const firstResponse = await client.chat.completions.create({
            model: 'gemini-2.0-flash',
            messages: messages
        });

        assert.equal(firstResponse.choices[0].finish_reason, 'tool_calls');
        const toolCall = firstResponse.choices[0].message.tool_calls[0];

        // 2. Second request with "Drift" (slightly different system prompt/whitespace)
        // This tests the new resilient fingerprinting.
        const d_messages = [
            { role: 'system', content: 'You are an engineer. ' }, // Notice the trailing space
            { role: 'user', content: 'Scan the project.' },
            firstResponse.choices[0].message,
            {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: 'Found 10 files.'
            }
        ];

        console.log("Filing drifted continuation request...");
        const secondResponse = await client.chat.completions.create({
            model: 'gemini-2.0-flash',
            messages: d_messages
        });

        // The mock CLI for 'tool_park' scenario should return a final text after the first tool result.
        assert.equal(secondResponse.choices[0].finish_reason, 'stop');
        assert.ok(secondResponse.choices[0].message.content.includes('Final answer'));
    });

    await t.test('Teardown', async () => {
        if (bridgeProc) bridgeProc.kill('SIGKILL');
    });
});
