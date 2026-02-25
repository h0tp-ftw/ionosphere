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
            API_KEY: 'test-key',
            NODE_ENV: 'test',
            GEMINI_DEBUG_HANDOFF: 'true'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
        let started = false;
        bridgeProc.stdout.on('data', (chunk) => {
            const out = chunk.toString();
            if (!started && out.includes('listening')) {
                started = true;
                setTimeout(resolve, 500);
            }
        });
        bridgeProc.stderr.on('data', (chunk) => {
            console.error(`[BRIDGE STDERR] ${chunk}`);
        });
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 5000);
    });
}

test('Proxy Garbage Collection and Narration Extraction', async (t) => {

    await t.test('Setup', async () => {
        await startBridge('tool_park');
    });

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'test-key',
        maxRetries: 0
    });

    await t.test('Should skip placeholder and extract narrated result', async () => {
        // 1. Initial request to trigger tool park
        const messages = [
            { role: 'user', content: 'Use the tool.' }
        ];

        console.log("Step 1: Filing initial request...");
        const firstResponse = await client.chat.completions.create({
            model: 'gemini-2.0-flash',
            messages: messages
        });

        assert.equal(firstResponse.choices[0].finish_reason, 'tool_calls');
        const toolCall = firstResponse.choices[0].message.tool_calls[0];
        console.log(`Step 1: Got tool call ${toolCall.id} for ${toolCall.function.name}`);

        // 2. Second request with "result missing" garbage AND a following narration (as complex content)
        const d_messages = [
            { role: 'user', content: 'Use the tool.' },
            firstResponse.choices[0].message,
            {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: 'result missing' // THE GARBAGE
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `[get_weather for '{"city":"London"}'] Result:\nSunny 25C` // THE NARRATION
                    }
                ]
            }
        ];

        console.log("Step 2: Filing request with placeholder + narration...");
        const secondResponse = await client.chat.completions.create({
            model: 'gemini-2.0-flash',
            messages: d_messages
        });

        // The mock CLI scenario 'tool_park' returns the result it received in the "Final answer"
        assert.equal(secondResponse.choices[0].finish_reason, 'stop');
        console.log("Response content:", secondResponse.choices[0].message.content);
        assert.ok(secondResponse.choices[0].message.content.includes('Sunny 25C'), 'Should have extracted narrated result');
    });

    await t.test('Teardown', async () => {
        if (bridgeProc) bridgeProc.kill('SIGKILL');
    });
});
