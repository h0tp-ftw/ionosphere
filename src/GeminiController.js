import { spawn } from 'child_process';
import EventEmitter from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';

/**
 * Accumulates chunked stdout into distinct JSON lines.
 */
export class JsonlAccumulator extends EventEmitter {
    constructor() {
        super();
        this.buffer = '';
    }

    push(chunk) {
        this.buffer += chunk.toString();

        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line) {
                try {
                    const parsed = JSON.parse(line);
                    this.emit('line', parsed);
                } catch (e) {
                    console.error(`[JsonlAccumulator] Failed to parse line: ${line}`, e);
                }
            }
        }
    }
}

/**
 * GeminiController — Stateless CLI Spawner
 */
export class GeminiController {
    constructor(cwd = process.cwd()) {
        this.cwd = cwd;
        this.tempDir = path.join(this.cwd, 'temp');
        this.processes = new Map();

        // Active callbacks for each turnId
        this.callbacksByTurn = new Map();

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Updates the callbacks for a running turn. 
     * Essential for "Warm Stateless Handoff" where a second HTTP request 
     * takes over the output of a process parked from a first request.
     */
    updateCallbacks(turnId, callbacks) {
        this.callbacksByTurn.set(turnId, callbacks);
        console.log(`[GeminiController] Callbacks updated/hijacked for turn ${turnId}`);
    }

    /**
     * Executes a strictly stateless CLI turn.
     * 1. Spawn `gemini -y -o stream-json -p <text> --settings <settingsPath>`
     * 2. Stream output events back via callbacks.
     */
    async sendPrompt(turnId, text, workspacePath = this.cwd, settingsPath = process.env.GEMINI_SETTINGS_JSON || path.join(this.cwd, '.gemini', 'settings.json'), systemPrompt = null, callbacks = {}) {
        try {
            this.callbacksByTurn.set(turnId, callbacks);

            let cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
            if (process.platform === 'win32' && !cliPath.endsWith('.cmd') && !cliPath.endsWith('.exe')) {
                cliPath += '.cmd';
            }

            const args = ['-o', 'stream-json'];

            // Write prompt to a temp file
            const tempPromptPath = path.join(workspacePath, `prompt-${randomUUID()}.txt`);
            fs.writeFileSync(tempPromptPath, text, 'utf-8');
            args.push('-p', `@${tempPromptPath}`);

            let systemPromptPath = null;
            if (systemPrompt !== null) {
                systemPromptPath = path.join(workspacePath, 'system.md');
                fs.writeFileSync(systemPromptPath, systemPrompt, 'utf-8');
            }

            console.log(`[GeminiController] Spawning stateless CLI: ${cliPath} ${args.join(' ')}`);

            const result = await new Promise((resolve, reject) => {
                const accumulator = new JsonlAccumulator();
                let lastResultJson = null;

                const spawnEnv = {
                    ...process.env,
                    GEMINI_SETTINGS_JSON: settingsPath,
                };

                if (systemPromptPath) {
                    spawnEnv.GEMINI_SYSTEM_MD = systemPromptPath;
                }

                const proc = spawn(cliPath, args, {
                    cwd: workspacePath,
                    env: spawnEnv,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: process.platform === 'win32',
                });

                this.processes.set(turnId, proc);

                // 10-minute timeout for ReAct loops
                const timeout = setTimeout(() => {
                    console.error(`[GeminiController] Turn ${turnId} timed out. Killing.`);
                    proc.kill();
                    reject(new Error('Turn timed out'));
                }, 10 * 60 * 1000);

                accumulator.on('line', (json) => {
                    const activeCallbacks = this.callbacksByTurn.get(turnId) || {};

                    if (json.type === 'message' && json.role === 'assistant') {
                        const content = (typeof json.content === 'object') ? json.content.text : json.content;
                        if (content && activeCallbacks.onText) activeCallbacks.onText(content);

                    } else if (json.type === 'tool_use' || json.type === 'toolCall') {
                        if (activeCallbacks.onToolCall) activeCallbacks.onToolCall({
                            id: json.tool_id || json.id || `call_${randomUUID().substring(0, 8)}`,
                            name: json.tool_name || json.name,
                            arguments: JSON.stringify(json.parameters ?? json.arguments ?? {})
                        });

                    } else if (json.type === 'error') {
                        if (activeCallbacks.onError) activeCallbacks.onError(json);

                    } else if (json.type === 'result') {
                        lastResultJson = json;
                        if (activeCallbacks.onResult) activeCallbacks.onResult(json);

                    } else if (json.type === 'tool_result' || json.type === 'init' || json.type === 'done') {
                        if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
                    } else {
                        if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
                    }
                });

                proc.stdout.on('data', (chunk) => {
                    accumulator.push(chunk);
                });

                proc.stderr.on('data', (chunk) => {
                    const stderrText = chunk.toString().trim();
                    if (stderrText) {
                        const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
                        console.error(`[Gemini CLI STDERR] ${stderrText}`);

                        const isAuthError = (/(please log in|auth|authorization)/i.test(stderrText) && !/unauthorized tool call/i.test(stderrText)) ||
                            (/credentials/i.test(stderrText) && !/loaded cached credentials/i.test(stderrText));

                        if (isAuthError) {
                            const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError({ type: 'error', message: errorMsg, code: 'AUTH_EXPIRED' });
                        }
                    }
                });

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    this.processes.delete(turnId);
                    this.callbacksByTurn.delete(turnId);

                    try {
                        if (fs.existsSync(tempPromptPath)) fs.unlinkSync(tempPromptPath);
                    } catch (_) { }

                    if (code === 0 || code === null) {
                        resolve(lastResultJson);
                    } else {
                        reject(new Error(`CLI process exited with code ${code}`));
                    }
                });

                proc.on('error', (err) => {
                    clearTimeout(timeout);
                    this.processes.delete(turnId);
                    this.callbacksByTurn.delete(turnId);
                    reject(new Error(`Failed to spawn CLI: ${err.message}`));
                });
            });

            return result;
        } catch (err) {
            console.error(`[GeminiController] Turn error: ${err.message}`);
            const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
            if (activeCallbacks.onError) activeCallbacks.onError({ type: 'error', message: err.message });
        }
    }

    /**
     * Cancels a running process.
     */
    cancelCurrentTurn(turnId) {
        const proc = this.processes.get(turnId);
        if (proc) {
            proc.kill('SIGINT');
            this.processes.delete(turnId);
            this.callbacksByTurn.delete(turnId);
        }
    }

    /**
     * Terminate all active processes.
     */
    destroyAll() {
        for (const [turnId, proc] of this.processes.entries()) {
            try { proc.kill('SIGKILL'); } catch (_) { }
        }
        this.processes.clear();
        this.callbacksByTurn.clear();
    }
}

