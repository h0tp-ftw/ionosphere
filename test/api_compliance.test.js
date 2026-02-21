/**
 * test/api_compliance.test.js
 *
 * HTTP-level compliance tests for the Ionosphere bridge SSE output.
 * Starts the bridge with a mock CLI and validates the SSE stream format
 * against the OpenAI chat completions streaming spec.
 *
 * Requires the bridge to be startable in test mode (GEMINI_CLI_PATH points
 * to the mock CLI). Run after `npm start` is NOT needed — we spawn inline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3099; // isolated port for tests

// ─── SSE parsing helpers ──────────────────────────────────────────────────────

/** Parse raw SSE text into array of { data } objects */
function parseSseChunks(rawText) {
    return rawText
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice('data: '.length).trim());
}

/** POST to bridge and collect full SSE response text */
async function postCompletion(body, scenario = 'text') {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: BRIDGE_PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': 'Bearer test-key'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ─── Bridge subprocess ────────────────────────────────────────────────────────

let bridgeProc = null;

async function startBridge(scenario = 'text') {
    // Dynamic import to spawn bridge in test mode
    const { spawn } = await import('child_process');
    const bridgeEntry = path.join(__dirname, '..', 'src', 'index.js');

    bridgeProc = spawn('node', [bridgeEntry], {
        env: {
            ...process.env,
            PORT: String(BRIDGE_PORT),
            GEMINI_CLI_PATH: `node ${MOCK_CLI}`,
            CLI_SCENARIO: scenario,
            API_KEY: 'test-key',
            NODE_ENV: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for bridge to be ready
    await new Promise((resolve, reject) => {
        let started = false;
        bridgeProc.stdout.on('data', (chunk) => {
            if (!started && chunk.toString().includes('listening')) {
                started = true;
                resolve();
            }
        });
        bridgeProc.stderr.on('data', () => { }); // suppress
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start in time')); }, 5000);
    });
}

async function stopBridge() {
    if (bridgeProc) {
        bridgeProc.kill();
        bridgeProc = null;
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('api_compliance - response has text/event-stream content type', async () => {
    await startBridge('text');
    try {
        const { headers } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        });
        assert.match(headers['content-type'], /text\/event-stream/);
    } finally {
        await stopBridge();
    }
});

test('api_compliance - all data lines are valid JSON (except [DONE])', async () => {
    await startBridge('text');
    try {
        const { body } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        });

        const lines = parseSseChunks(body);
        for (const line of lines) {
            if (line === '[DONE]') continue;
            assert.doesNotThrow(() => JSON.parse(line), `Invalid JSON: ${line}`);
        }
    } finally {
        await stopBridge();
    }
});

test('api_compliance - text chunks have choices[0].delta.content', async () => {
    await startBridge('text');
    try {
        const { body } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        });

        const chunks = parseSseChunks(body)
            .filter(l => l !== '[DONE]')
            .map(l => JSON.parse(l))
            .filter(c => c.choices?.[0]?.delta?.content !== undefined);

        assert.ok(chunks.length > 0, 'Should have at least one text chunk');
        const allText = chunks.map(c => c.choices[0].delta.content).join('');
        assert.ok(allText.length > 0, 'Concatenated text should be non-empty');
    } finally {
        await stopBridge();
    }
});

test('api_compliance - final chunk has finish_reason: stop and usage fields', async () => {
    await startBridge('text');
    try {
        const { body } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        });

        const chunks = parseSseChunks(body)
            .filter(l => l !== '[DONE]')
            .map(l => JSON.parse(l));

        const finalChunk = chunks.find(c => c.choices?.[0]?.finish_reason === 'stop');
        assert.ok(finalChunk, 'Should have a chunk with finish_reason: stop');
        assert.ok(finalChunk.usage, 'Final chunk should have usage');
        assert.ok(typeof finalChunk.usage.prompt_tokens === 'number');
        assert.ok(typeof finalChunk.usage.completion_tokens === 'number');
        assert.ok(typeof finalChunk.usage.total_tokens === 'number');
    } finally {
        await stopBridge();
    }
});

test('api_compliance - stream ends with data: [DONE]', async () => {
    await startBridge('text');
    try {
        const { body } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        });

        const lines = parseSseChunks(body);
        assert.equal(lines[lines.length - 1], '[DONE]', 'Last SSE line should be [DONE]');
    } finally {
        await stopBridge();
    }
});

test('api_compliance - tool call chunks have correct OpenAI structure', async () => {
    await startBridge('tool_use');
    try {
        const { body } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'use a tool' }],
            stream: true,
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather',
                    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
                }
            }]
        });

        const chunks = parseSseChunks(body)
            .filter(l => l !== '[DONE]')
            .map(l => JSON.parse(l));

        const toolChunks = chunks.filter(c => c.choices?.[0]?.delta?.tool_calls);
        assert.ok(toolChunks.length > 0, 'Should have tool call chunks');

        const tc = toolChunks[0].choices[0].delta.tool_calls[0];
        assert.ok(tc.id, 'Tool call must have id');
        assert.equal(tc.type, 'function');
        assert.ok(tc.function?.name, 'Tool call must have function.name');
        assert.ok(typeof tc.function?.arguments === 'string', 'arguments must be a JSON string');
        // Validate finish_reason on tool call chunk
        assert.equal(toolChunks[0].choices[0].finish_reason, 'tool_calls');
    } finally {
        await stopBridge();
    }
});

test('api_compliance - chunk structure has required OpenAI fields', async () => {
    await startBridge('text');
    try {
        const { body } = await postCompletion({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        });

        const chunks = parseSseChunks(body)
            .filter(l => l !== '[DONE]')
            .map(l => JSON.parse(l));

        for (const chunk of chunks) {
            assert.ok(chunk.id, 'chunk.id required');
            assert.equal(chunk.object, 'chat.completion.chunk');
            assert.ok(typeof chunk.created === 'number');
            assert.ok(chunk.model);
            assert.ok(Array.isArray(chunk.choices));
            assert.equal(chunk.choices[0].index, 0);
        }
    } finally {
        await stopBridge();
    }
});
