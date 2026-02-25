import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import FormData from 'form-data';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const BRIDGE_PORT = 3200;
const API_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

let bridgeProc = null;

async function startBridge() {
    console.log(`[Test Setup] Starting bridge...`);
    const bridgeEntry = path.join(__dirname, '..', 'src', 'index.js');
    bridgeProc = spawn('node', [bridgeEntry], {
        env: {
            ...process.env,
            PORT: String(BRIDGE_PORT),
            GEMINI_CLI_PATH: `node ${MOCK_CLI}`,
            API_KEY: 'test-key',
            NODE_ENV: 'test',
            MAX_CONCURRENT_CLI: '1',
            GEMINI_DEBUG_PROMPTS: 'true'
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
                setTimeout(resolve, 2000);
            }
        };
        bridgeProc.stdout.on('data', onData);
        setTimeout(() => { if (!started) reject(new Error('Bridge did not start')); }, 10000);
    });
}

async function stopBridge() {
    if (bridgeProc) {
        bridgeProc.kill('SIGKILL');
        bridgeProc = null;
        await new Promise(r => setTimeout(r, 500));
    }
}

test('Multimodal File Upload Support', async (t) => {
    await startBridge();

    await t.test('Upload multiple files and verify prompt content', async () => {
        const form = new FormData();
        form.append('model', 'gemini-2.5-flash');
        form.append('messages', JSON.stringify([{ role: 'user', content: 'What is in these files?' }]));

        // Create dummy files
        const file1Path = path.join(__dirname, 'test_file1.txt');
        const file2Path = path.join(__dirname, 'test_file2.png');
        fs.writeFileSync(file1Path, 'This is file 1 content');
        fs.writeFileSync(file2Path, 'FAKE_IMAGE_DATA');

        form.append('file1', fs.createReadStream(file1Path));
        form.append('file2', fs.createReadStream(file2Path));

        // Use a collector for bridge output
        let bridgeOutput = '';
        const onBridgeData = (chunk) => {
            bridgeOutput += chunk.toString();
        };
        bridgeProc.stdout.on('data', onBridgeData);

        const responseData = await new Promise((resolve, reject) => {
            const req = http.request(`${API_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    ...form.getHeaders(),
                    'Authorization': 'Bearer test-key'
                }
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(JSON.parse(body)));
            });

            req.on('error', reject);
            form.pipe(req);
        });

        // Search for prompt file path in logs
        // Example: PROMPT_FILE=C:\...\prompt-....txt
        const promptFileMatch = bridgeOutput.match(/PROMPT_FILE=([^\s]+)/);
        if (promptFileMatch) {
            // Since GEMINI_DEBUG_PROMPTS=true, the bridge logs the prompt content
            // We just verify that we see @ followed by something that looks like our files
            assert.ok(/@.*file1-.*\.txt/.test(bridgeOutput), 'Bridge should log file1 path in prompt');
            assert.ok(/@.*file2-.*\.png/.test(bridgeOutput), 'Bridge should log file2 path in prompt');
        }

        // Cleanup dummy files
        fs.unlinkSync(file1Path);
        fs.unlinkSync(file2Path);

        assert.ok(responseData.choices[0].message.content, 'Response should contain content');
    });

    await t.test('OpenAI-style Base64 PDF support', async () => {
        const pdfBase64 = Buffer.from('%PDF-1.4 mock content').toString('base64');
        const dataUri = `data:application/pdf;base64,${pdfBase64}`;

        const payload = {
            model: 'gemini-2.5-flash',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Analyze this PDF' },
                        { type: 'image_url', image_url: { url: dataUri } }
                    ]
                }
            ]
        };

        // Use a collector for bridge output
        let bridgeOutput = '';
        const onBridgeData = (chunk) => {
            bridgeOutput += chunk.toString();
        };
        bridgeProc.stdout.on('data', onBridgeData);

        const responseData = await new Promise((resolve, reject) => {
            const req = http.request(`${API_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-key'
                }
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(JSON.parse(body)));
            });

            req.on('error', reject);
            req.write(JSON.stringify(payload));
            req.end();
        });

        // Verify bridge logs show the prepended PDF
        assert.ok(/@.*attachment_.*\.pdf/.test(bridgeOutput), 'Bridge should log PDF attachment in prompt');
        assert.ok(bridgeOutput.includes('USER: Analyze this PDF'), 'Bridge should log the text content');

        assert.ok(responseData.choices[0].message.content, 'Response should contain content');
    });

    await t.test('OpenAI Files API (Upload + Reference + Delete)', async () => {
        // 1. Upload
        const form = new FormData();
        const testFilePath = path.join(__dirname, 'persistent_test.txt');
        fs.writeFileSync(testFilePath, 'Persistent file content');
        form.append('file', fs.createReadStream(testFilePath));
        form.append('purpose', 'assistants');

        const fileMeta = await new Promise((resolve, reject) => {
            const req = http.request(`${API_URL}/v1/files`, {
                method: 'POST',
                headers: {
                    ...form.getHeaders(),
                    'Authorization': 'Bearer test-key'
                }
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(JSON.parse(body)));
            });
            req.on('error', reject);
            form.pipe(req);
        });

        assert.ok(fileMeta.id.startsWith('file-'), 'Should return a file_id');
        assert.equal(fileMeta.filename, 'persistent_test.txt');

        // 2. Reference in Chat
        const payload = {
            model: 'gemini-2.5-flash',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What is inside this file?' },
                        { type: 'image_url', image_url: { id: fileMeta.id } }
                    ]
                }
            ]
        };

        let bridgeOutput = '';
        const onBridgeData = (chunk) => {
            bridgeOutput += chunk.toString();
        };
        bridgeProc.stdout.on('data', onBridgeData);

        await new Promise((resolve, reject) => {
            const req = http.request(`${API_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-key'
                }
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(JSON.parse(body)));
            });
            req.on('error', reject);
            req.write(JSON.stringify(payload));
            req.end();
        });

        // Verify resolution
        assert.ok(bridgeOutput.includes('@' + fileMeta.path), 'Bridge should resolve file_id to local path');

        // 3. Delete
        const deleteResult = await new Promise((resolve, reject) => {
            const req = http.request(`${API_URL}/v1/files/${fileMeta.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer test-key' }
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(JSON.parse(body)));
            });
            req.on('error', reject);
            req.end();
        });

        assert.strictEqual(deleteResult.deleted, true);
        assert.ok(!fs.existsSync(fileMeta.path), 'File should be removed from disk');

        // Cleanup local test file
        fs.unlinkSync(testFilePath);
    });

    await stopBridge();
});
