/**
 * test/models.test.js
 *
 * Tests for the /v1/models endpoints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = 3101; // isolated port for models tests

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function getJson(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: BRIDGE_PORT,
            path: path,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer test-key'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let body = data;
                try { body = JSON.parse(data); } catch (e) { }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── Bridge subprocess ────────────────────────────────────────────────────────

let bridgeProc = null;

async function startBridge() {
    const { spawn } = await import('child_process');
    const bridgeEntry = path.join(__dirname, '..', 'src', 'index.js');

    bridgeProc = spawn('node', [bridgeEntry], {
        env: {
            ...process.env,
            PORT: String(BRIDGE_PORT),
            API_KEY: 'test-key',
            GEMINI_MODEL: 'gemini-2.5-flash-lite',
            NODE_ENV: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise((resolve, reject) => {
        let started = false;
        bridgeProc.stdout.on('data', (chunk) => {
            if (!started && chunk.toString().includes('listening')) {
                started = true;
                resolve();
            }
        });
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

test('models - /v1/models returns model list', async () => {
    await startBridge();
    try {
        const { status, body } = await getJson('/v1/models');
        assert.equal(status, 200);
        assert.equal(body.object, 'list');
        assert.ok(Array.isArray(body.data));
        const ids = body.data.map(m => m.id);
        const expectedIds = [
            "auto-gemini-3",
            "auto-gemini-2.5",
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini-2.0-flash"
        ];
        for (const id of expectedIds) {
            assert.ok(ids.includes(id), `Missing model ${id}`);
        }
        assert.ok(!ids.includes('gemini-cli'), 'gemini-cli should not be in the list');
        for (const model of body.data) {
            assert.equal(model.owned_by, 'google');
        }
    } finally {
        await stopBridge();
    }
});

test('models - /v1/models/:model returns specific model', async () => {
    await startBridge();
    try {
        const { status, body } = await getJson('/v1/models/gemini-2.5-flash-lite');
        assert.equal(status, 200);
        assert.equal(body.id, 'gemini-2.5-flash-lite');
        assert.equal(body.object, 'model');
        assert.equal(body.owned_by, 'google');
    } finally {
        await stopBridge();
    }
});

test('models - /v1/models/non-existent-model returns 404', async () => {
    await startBridge();
    try {
        const { status, body } = await getJson('/v1/models/non-existent-model');
        assert.equal(status, 404);
        assert.ok(body.error);
        assert.equal(body.error.code, 'model_not_found');
    } finally {
        await stopBridge();
    }
});
