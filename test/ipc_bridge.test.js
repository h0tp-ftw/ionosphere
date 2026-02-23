/**
 * test/ipc_bridge.test.js
 *
 * Unit tests for the per-turn IPC socket server that mediates between
 * the Ionosphere bridge (index.js) and the ToolBridge MCP server.
 *
 * Tests the socket protocol in isolation without spawning the bridge
 * or the Gemini CLI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';

function makeIpcPath() {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\ionosphere-test-${randomUUID()}`;
    }
    return path.join(os.tmpdir(), `ipc-test-${randomUUID()}.sock`);
}

/**
 * Creates a minimal IPC server that mirrors the behavior in index.js:
 * - Receives tool_call messages
 * - Fires onToolCall callback
 * - Allows sending tool_result back
 */
function createTestIpcServer(ipcPath, onToolCall) {
    const pendingCalls = new Map();

    const server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
            buf += chunk.toString();
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);

            try {
                const msg = JSON.parse(line);
                if (msg.event === 'tool_call') {
                    const callKey = randomUUID();
                    pendingCalls.set(callKey, socket);
                    onToolCall({ callKey, name: msg.name, arguments: msg.arguments });
                }
            } catch (e) { /* ignore parse errors */ }
        });
    });

    const resolve = (callKey, result) => {
        const socket = pendingCalls.get(callKey);
        if (!socket) return false;
        pendingCalls.delete(callKey);
        socket.write(JSON.stringify({ event: 'tool_result', result }) + '\n');
        socket.end();
        return true;
    };

    return { server, resolve, pendingCalls };
}

// ─── Basic protocol ───────────────────────────────────────────────────────────

test('ipc_bridge - server receives tool_call and fires callback', async () => {
    const ipcPath = makeIpcPath();
    const received = [];

    const { server, resolve } = createTestIpcServer(ipcPath, (call) => {
        received.push(call);
        // Immediately resolve to unblock the client
        resolve(call.callKey, 'test result');
    });

    await new Promise(r => server.listen(ipcPath, r));

    // Simulate ToolBridge connecting and sending a tool_call
    await new Promise((done, fail) => {
        const client = net.createConnection(ipcPath, () => {
            client.write(JSON.stringify({
                event: 'tool_call',
                name: 'get_weather',
                arguments: { city: 'London' }
            }) + '\n');
        });

        let buf = '';
        client.on('data', (chunk) => {
            buf += chunk;
            if (buf.includes('\n')) {
                const reply = JSON.parse(buf.trim());
                assert.equal(reply.event, 'tool_result');
                assert.equal(reply.result, 'test result');
                client.destroy();
                done();
            }
        });

        client.on('error', fail);
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].name, 'get_weather');

    server.close();
    if (process.platform !== 'win32' && fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
});

// ─── Concurrent calls ─────────────────────────────────────────────────────────

test('ipc_bridge - handles multiple concurrent tool calls independently', async () => {
    const ipcPath = makeIpcPath();
    const received = [];

    const { server, resolve } = createTestIpcServer(ipcPath, (call) => {
        received.push(call);
    });

    await new Promise(r => server.listen(ipcPath, r));

    // Fire 3 concurrent tool calls
    const promises = ['fn_a', 'fn_b', 'fn_c'].map(name => {
        return new Promise((done, fail) => {
            const client = net.createConnection(ipcPath, () => {
                client.write(JSON.stringify({ event: 'tool_call', name, arguments: {} }) + '\n');
            });
            let buf = '';
            client.on('data', (chunk) => {
                buf += chunk;
                if (buf.includes('\n')) {
                    const reply = JSON.parse(buf.trim());
                    assert.equal(reply.event, 'tool_result');
                    client.destroy();
                    done(reply.result);
                }
            });
            client.on('error', fail);
        });
    });

    // Wait a tick for all tool calls to arrive, then resolve them
    await new Promise(r => setTimeout(r, 50));
    assert.equal(received.length, 3);

    // Resolve in reverse order to prove independence
    for (const call of [...received].reverse()) {
        resolve(call.callKey, `result_for_${call.name}`);
    }

    const results = await Promise.all(promises);
    // All results must be present (order may vary due to async)
    const names = results.map(r => r.split('result_for_')[1]).sort();
    assert.deepEqual(names, ['fn_a', 'fn_b', 'fn_c']);

    server.close();
    if (process.platform !== 'win32' && fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
});

// ─── Message framing ─────────────────────────────────────────────────────────

test('ipc_bridge - handles newline-delimited JSON framing correctly', async () => {
    const ipcPath = makeIpcPath();
    const received = [];

    const { server, resolve } = createTestIpcServer(ipcPath, (call) => {
        received.push(call);
        resolve(call.callKey, 'ok');
    });

    await new Promise(r => server.listen(ipcPath, r));

    await new Promise((done, fail) => {
        const client = net.createConnection(ipcPath, () => {
            // Send in two TCP segments (no guarantee of delivery boundary)
            const msg = JSON.stringify({ event: 'tool_call', name: 'fragmented_test', arguments: {} });
            client.write(msg.slice(0, 10));
            setTimeout(() => client.write(msg.slice(10) + '\n'), 10);
        });

        let buf = '';
        client.on('data', (chunk) => {
            buf += chunk;
            if (buf.includes('\n')) {
                client.destroy();
                done();
            }
        });
        client.on('error', fail);
    });

    assert.equal(received[0].name, 'fragmented_test');

    server.close();
    if (process.platform !== 'win32' && fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath);
});

// ─── Cleanup on destroy ───────────────────────────────────────────────────────

test('ipc_bridge - socket file is removed on test cleanup (Unix only)', async () => {
    if (process.platform === 'win32') return; // Named pipes cleaned up by OS

    const ipcPath = makeIpcPath();
    const { server } = createTestIpcServer(ipcPath, () => { });
    await new Promise(r => server.listen(ipcPath, r));

    assert.ok(fs.existsSync(ipcPath), 'Socket file should exist while server is listening');

    await new Promise(r => server.close(r));
    try { fs.unlinkSync(ipcPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    assert.ok(!fs.existsSync(ipcPath), 'Socket file should be removed after cleanup');
});
