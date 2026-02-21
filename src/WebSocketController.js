import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { generateConfig } from '../scripts/generate_settings.js';

/**
 * WebSocketController
 * 
 * Handles bidirectional streaming between the native pi-ai client and the Gemini CLI.
 * Implements a "Framed Pipe" to guarantee payload integrity while remaining extremely fast
 * by avoiding JSON.parse on the backend and buffering strict NDJSON arrays inline.
 */
export class WebSocketController {
    constructor(server, baseTempDir) {
        this.wss = new WebSocketServer({ server, path: '/v1/stream' });
        this.baseTempDir = baseTempDir;

        console.log(`[WebSocketController] Bound WebSocket Native Pi-AI endpoint to /v1/stream`);

        // True Multiplexing: Map of execution_id -> child_process
        this.activeExecutions = new Map();

        this.wss.on('connection', (ws) => {
            console.log(`[WebSocketController] Client connected`);
            this.handleConnection(ws);
        });
    }

    handleConnection(ws) {
        let initialized = false;
        let turnId = randomUUID();
        let turnTempDir = path.join(this.baseTempDir, turnId);
        let cliProcess = null;

        // The NDJSON Frame Buffer
        let stdoutBuffer = '';

        const cleanup = () => {
            if (cliProcess) {
                try {
                    cliProcess.kill('SIGKILL');
                } catch (e) { }
                cliProcess = null;
            }
            try {
                if (fs.existsSync(turnTempDir)) {
                    fs.rmSync(turnTempDir, { recursive: true, force: true });
                }
            } catch (e) {
                console.error(`[WebSocketController] Clean up failed for turn ${turnId}:`, e);
            }
        };

        ws.on('close', () => {
            console.log(`[WebSocketController] Client disconnected from turn ${turnId}`);
            cleanup();
        });

        ws.on('error', (err) => {
            console.error(`[WebSocketController] Socket error on turn ${turnId}:`, err);
            cleanup();
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());

                if (!initialized) {
                    const executionId = message.execution_id;
                    if (!executionId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Missing execution_id in init payload' }));
                        return ws.close();
                    }

                    initialized = true;

                    const { prompt, mcpServers, systemPrompt, modelConfig } = message.data;

                    if (!fs.existsSync(turnTempDir)) {
                        fs.mkdirSync(turnTempDir, { recursive: true });
                    }

                    // 1. Generate Settings & Temps
                    const settingsDir = path.join(turnTempDir, '.gemini');
                    const settingsPath = path.join(settingsDir, 'settings.json');

                    let modelName = modelConfig?.model || 'gemini-2.5-pro';

                    generateConfig({ targetPath: settingsPath, mcpServers, customSettings: null, modelName });

                    const tempPromptPath = path.join(turnTempDir, `prompt-${randomUUID()}.txt`);
                    fs.writeFileSync(tempPromptPath, prompt || '', 'utf-8');

                    // 2. Build CLI args
                    let cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
                    let args = ['-y', '-o', 'stream-json', '-p', `@${tempPromptPath}`];

                    // Test Injector
                    if (process.env.GEMINI_CLI_PATH === 'node' && mcpServers?.dummy?.command) {
                        args = [mcpServers.dummy.command];
                    }

                    const spawnEnv = {
                        ...process.env,
                        GEMINI_SETTINGS_JSON: settingsPath,
                        CI: '1',
                        FORCE_COLOR: '0',
                        PYTHONUNBUFFERED: '1',
                        // Disable interactive prompts and pagers that block stdout
                        PAGER: 'cat'
                    };

                    if (systemPrompt) {
                        const systemPromptPath = path.join(turnTempDir, 'system.md');
                        fs.writeFileSync(systemPromptPath, systemPrompt, 'utf-8');
                        spawnEnv.GEMINI_SYSTEM_MD = systemPromptPath;
                    }

                    console.log(`[WebSocketController] Spawning CLI for Pi-AI Provider: ${cliPath} ${args.join(' ')}`);

                    // 3. Spawn the Process
                    cliProcess = spawn(cliPath, args, {
                        cwd: turnTempDir,
                        env: spawnEnv,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        shell: process.platform === 'win32'
                    });

                    // 4. The Framed Pipe: Fast NDJSON Buffering
                    // Instead of parsing JSON objects, we buffer raw text and split by newline.
                    cliProcess.stdout.on('data', (chunk) => {
                        const chunkStr = chunk.toString();
                        stdoutBuffer += chunkStr;

                        let newlineIndex;
                        while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
                            // Slice the string up to the newline
                            const frame = stdoutBuffer.slice(0, newlineIndex).trim();
                            // Keep the remainder in the buffer
                            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

                            if (frame) {
                                // Micro-validation check: must look like a JSON object/array
                                if ((frame.startsWith('{') && frame.endsWith('}')) ||
                                    (frame.startsWith('[') && frame.endsWith(']'))) {

                                    // Wrap the raw frame in an envelope
                                    const envelope = JSON.stringify({
                                        execution_id: executionId,
                                        type: 'frame',
                                        data: JSON.parse(frame) // Parse briefly to ensure valid JSON structure in the envelope
                                    });
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(envelope);
                                    }
                                } else {
                                    console.warn(`[WebSocketController] Dropping malformed CLI output frame: ${frame}`);
                                }
                            }
                        }
                    });

                    cliProcess.stderr.on('data', (chunk) => {
                        const stderrText = chunk.toString().trim();
                        if (stderrText) {
                            console.error(`[WebSocketController CLI STDERR] ${stderrText}`);
                        }
                    });

                    cliProcess.on('close', (code) => {
                        console.log(`[WebSocketController] CLI exited with code ${code} for execution ${executionId}`);
                        this.activeExecutions.delete(executionId);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ execution_id: executionId, type: 'done', data: { code } }));
                        }
                        cleanup();
                    });

                    cliProcess.on('error', (err) => {
                        console.error(`[WebSocketController] CLI Spawn Error for execution ${executionId}:`, err);
                        this.activeExecutions.delete(executionId);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ execution_id: executionId, type: 'error', data: { message: err.message } }));
                        }
                        cleanup();
                    });

                    this.activeExecutions.set(executionId, cliProcess);

                } else {
                    // Processing subsequent messages from Pi-AI (Reverse Tunnel Tool Results)
                    // Write directly to the running CLI's standard input
                    const targetExecutionId = message.execution_id;
                    if (message.type === 'tool_result' && targetExecutionId) {
                        const targetProcess = this.activeExecutions.get(targetExecutionId);
                        if (targetProcess && !targetProcess.killed) {
                            try {
                                const resultPayload = JSON.stringify(message.data) + '\n';
                                console.log(`[WebSocketController] Pumping Tool Result back to CLI stdin for ${targetExecutionId} (${resultPayload.length} bytes)`);
                                targetProcess.stdin.write(resultPayload);
                            } catch (e) {
                                console.error(`[WebSocketController] Failed to write to CLI stdin for ${targetExecutionId}:`, e);
                            }
                        } else {
                            console.warn(`[WebSocketController] Received tool_result for dead or unknown execution_id: ${targetExecutionId}`);
                        }
                    }
                }

            } catch (err) {
                console.error(`[WebSocketController] Message parsing error:`, err);
            }
        });
    }
}
