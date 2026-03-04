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

async function startBridge(warmHandoff = 'true') {
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
            CLI_SCENARIO: 'tool_park',
            API_KEY: 'cold-handoff-key',
            WARM_HANDOFF_ENABLED: warmHandoff,
            NODE_ENV: 'test'
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
            if (process.env.DEBUG_TEST) console.log(`[Bridge] ${out}`);
        });
        bridgeProc.stderr.on('data', (chunk) => {
            if (process.env.DEBUG_TEST) console.error(`[Bridge Error] ${chunk}`);
        });
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 5000);
    });
}

test('Cold Handoff Verification', async (t) => {

    const client = new OpenAI({
        baseURL: API_URL,
        apiKey: 'cold-handoff-key',
        maxRetries: 0
    });

    await t.test('Warm Handoff Enabled (Default)', async () => {
        await startBridge('true');

        const messages = [
            { role: 'user', content: 'Trigger tool.' }
        ];

        console.log("Filing request (Warm)...");
        const response = await client.chat.completions.create({
            model: 'gemini-2.0-flash',
            messages: messages
        });

        assert.equal(response.choices[0].finish_reason, 'tool_calls');

        // In warm mode, the process should be alive (mock_cli for tool_park doesn't exit immediately on tool call unless told)
        // We can't easily check the bridge's internal Map, but we can see the log output if we captured it.
    });

    await t.test('Cold Handoff Enabled (WARM_HANDOFF_ENABLED=false)', async () => {
        await startBridge('false');

        const messages = [
            { role: 'user', content: 'Trigger tool.' }
        ];

        let bridgeOutput = "";
        bridgeProc.stdout.on('data', (chunk) => {
            bridgeOutput += chunk.toString();
        });

        console.log("Filing request (Cold)...");
        const response = await client.chat.completions.create({
            model: 'gemini-2.0-flash',
            messages: messages
        });

        assert.equal(response.choices[0].finish_reason, 'tool_calls');

        // Wait a bit for the termination log to appear
        await new Promise(r => setTimeout(r, 1000));

        assert.ok(bridgeOutput.includes('Cold Handoff: Terminating process after yielding response.'), 'Should log cold handoff termination');
        assert.ok(bridgeOutput.includes('Process closed for turn'), 'Process should have closed');
    });

    await t.test('Teardown', async () => {
        if (bridgeProc) bridgeProc.kill('SIGKILL');
    });
});
