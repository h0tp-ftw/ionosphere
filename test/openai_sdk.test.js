import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3100;
const API_URL = `http://127.0.0.1:${BRIDGE_PORT}/v1`;

let bridgeProc = null;

async function startSharedBridge(scenario = 'text') {
    console.log(`[Test Setup] Starting bridge with scenario: ${scenario}`);
    if (bridgeProc) {
        console.log('[Test Setup] Killing existing bridge...');
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
            API_KEY: 'test-sdk-key',
            NODE_ENV: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    bridgeProc.stdout.on('data', (c) => process.stdout.write(`[BRIDGE] ${c}`));
    bridgeProc.stderr.on('data', (c) => process.stderr.write(`[BRIDGE ERR] ${c}`));

    return new Promise((resolve, reject) => {
        let started = false;
        const onData = (chunk) => {
            if (!started && chunk.toString().includes('listening')) {
                started = true;
                setTimeout(resolve, 3000);
            }
        };
        bridgeProc.stdout.on('data', onData);
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 10000);
    });
}

async function stopSharedBridge() {
    if (bridgeProc) {
        console.log('[Test Teardown] Stopping bridge...');
        bridgeProc.kill('SIGKILL');
        bridgeProc = null;
        await new Promise(r => setTimeout(r, 1000));
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('OpenAI Compliance Suite', async (t) => {

    await t.test('Setup Bridge', async () => {
        await startSharedBridge('text');
    });

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'test-sdk-key',
        maxRetries: 0,
        timeout: 10000
    });

    await t.test('Streaming Text Completion', async () => {
        console.log('[Test] Requesting Streaming Completion...');
        const stream = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });

        let fullText = '';
        for await (const chunk of stream) {
            fullText += chunk.choices[0]?.delta?.content || '';
        }
        console.log(`[Test] Received total: ${fullText.length} chars`);
        assert.ok(fullText.includes('mock response'));
    });

    await t.test('Non-streaming Text Completion', async () => {
        console.log('[Test] Requesting Non-streaming Completion...');
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'hello non-stream' }],
            stream: false,
        });

        console.log('[Test] Received response:', response.choices[0].message.content);
        assert.ok(response.choices[0].message.content.includes('mock response'));
        assert.ok(response.usage.total_tokens > 0);
    });

    await t.test('Usage Metrics (Streaming)', async () => {
        const stream = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });

        let finalUsage = null;
        for await (const chunk of stream) {
            if (chunk.usage) finalUsage = chunk.usage;
        }
        assert.ok(finalUsage?.total_tokens > 0);
    });

    await t.test('Multimodal (Images) Support', async () => {
        await startSharedBridge('vision');
        console.log('[Test] Requesting Vision Completion...');
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: "What's in this image?" },
                    { type: 'image_url', image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }
                ]
            }],
            stream: false,
        });

        console.log('[Test] Vision response:', response.choices[0].message.content);
        assert.ok(response.choices[0].message.content.includes('landscape'));
    });

    await t.test('Error Handling (Invalid Auth)', async () => {
        const badClient = new OpenAI({
            baseURL: API_URL,
            apiKey: 'wrong-key',
            maxRetries: 0
        });

        try {
            await badClient.chat.completions.create({
                model: 'gemini-2.5-flash-lite',
                messages: [{ role: 'user', content: 'hi' }]
            });
            assert.fail('Should have thrown 401');
        } catch (err) {
            assert.strictEqual(err.status, 401);
            console.log('[Test] Caught expected 401 error');
        }
    });

    await t.test('Error Handling (CLI Failure)', async () => {
        await startSharedBridge('error');
        try {
            await client.chat.completions.create({
                model: 'gemini-2.5-flash-lite',
                messages: [{ role: 'user', content: 'fail please' }]
            });
            assert.fail('Should have thrown 500');
        } catch (err) {
            assert.strictEqual(err.status, 500);
            console.log('[Test] Caught expected 500 CLI error');
        }
    });

    await t.test('System Prompt Propagation', async () => {
        await startSharedBridge('text');
        const response = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'Who are you?' }
            ],
            stream: false,
        });
        assert.ok(response.choices[0].message.content.includes('mock response'));
    });

    await t.test('Switch to Tool Scenario', async () => {
        await startSharedBridge('tool_use');
    });

    await t.test('Multi-turn Handoff', async () => {
        console.log('[Test] Step 1: Triggering tool call');
        const stream1 = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'use a tool' }],
            tools: [{
                type: 'function',
                function: { name: 'get_weather', parameters: { type: 'object', properties: {} } }
            }],
            stream: true,
        });

        let toolCall = null;
        for await (const chunk of stream1) {
            const tc = chunk.choices[0]?.delta?.tool_calls?.[0];
            if (tc) toolCall = tc;
        }
        assert.ok(toolCall);

        console.log('[Test] Step 2: Sending tool result (Handoff)');
        const stream2 = await client.chat.completions.create({
            model: 'gemini-2.5-flash-lite',
            messages: [
                { role: 'user', content: 'use a tool' },
                { role: 'assistant', content: null, tool_calls: [toolCall] },
                { role: 'tool', tool_call_id: toolCall.id, content: 'Rainy' }
            ],
            stream: true,
        });

        let finalResponse = '';
        for await (const chunk of stream2) {
            finalResponse += chunk.choices[0]?.delta?.content || '';
        }
        assert.ok(finalResponse.includes('London'));
    });

    await t.test('Teardown', async () => {
        await stopSharedBridge();
    });
});
