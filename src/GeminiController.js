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
    async sendPrompt(turnId, text, workspacePath = this.cwd, settingsPath = process.env.GEMINI_SETTINGS_JSON || path.join(this.cwd, '.gemini', 'settings.json'), systemPrompt = null, callbacks = {}, extraEnv = {}) {
        try {
            this.callbacksByTurn.set(turnId, callbacks);

            const args = ['-y', '-o', 'stream-json'];

            // Write prompt to a temp file
            const tempPromptPath = path.join(workspacePath, `prompt-${randomUUID()}.txt`);
            fs.writeFileSync(tempPromptPath, text, 'utf-8');
            args.push('-p', `@${tempPromptPath}`);

            let systemPromptPath = null;
            if (systemPrompt !== null) {
                systemPromptPath = path.join(workspacePath, 'system.md');
                fs.writeFileSync(systemPromptPath, systemPrompt, 'utf-8');
            }

            let cliPath = process.env.GEMINI_CLI_PATH || path.join(this.cwd, 'node_modules', '.bin', 'gemini');
            let finalArgs = [...args];
            let executable = cliPath;

            // Handle cases where cliPath contains the runner (e.g. "node cli.js")
            if (cliPath.includes(' ')) {
                const parts = cliPath.split(' ');
                executable = parts[0];
                finalArgs = [...parts.slice(1), ...finalArgs];
            } else if (cliPath.endsWith('.js')) {
                executable = 'node';
                finalArgs = [cliPath, ...finalArgs];
            } else if (process.platform === 'win32' && cliPath === 'gemini') {
                executable = 'gemini.cmd';
            }

            console.log(`[GeminiController] Spawning stateless CLI: ${executable} ${finalArgs.join(' ')}`);

            const result = await new Promise((resolve, reject) => {
                const accumulator = new JsonlAccumulator();
                let lastResultJson = null;

                const spawnEnv = {
                    ...process.env,
                    GEMINI_SETTINGS_JSON: settingsPath,
                    ...extraEnv
                };

                if (systemPromptPath) {
                    spawnEnv.GEMINI_SYSTEM_MD = systemPromptPath;
                }

                const proc = spawn(executable, finalArgs, {
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
                        if (content) {
                            // Intercept "leaked" tool calls that the model might write as text heritage
                            const actionRegex = /\[ACTION: Called tool '([^']+)' with args: (.*?)\]/gs;
                            let match;
                            let cleanedContent = content;

                            while ((match = actionRegex.exec(content)) !== null) {
                                const [fullMatch, toolName, argsStr] = match;
                                console.log(`[GeminiController] Intercepted leaked tool call in text: ${toolName}`);
                                if (activeCallbacks.onToolCall) {
                                    activeCallbacks.onToolCall({
                                        id: `leak_${randomUUID().substring(0, 8)}`,
                                        name: toolName,
                                        arguments: argsStr.trim()
                                    });
                                }
                            }

                            // Remove the leaked tool calls from the text before sending it to the client
                            cleanedContent = content.replace(actionRegex, '').trim();
                            if (cleanedContent && activeCallbacks.onText) {
                                activeCallbacks.onText(cleanedContent);
                            }
                        }

                    } else if (json.type === 'tool_use' || json.type === 'toolCall') {
                        const toolName = json.tool_name || json.name;
                        const transparentTools = ['google_web_search'];

                        if (transparentTools.includes(toolName)) {
                            console.log(`[GeminiController] Transparently executing native tool: ${toolName}`);
                            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
                        } else {
                            // Non-transparent tools (MCP tools) are handled via the ionosphere-tool-bridge and IPC.
                            // We do NOT dispatch onToolCall here to avoid double-dispatching to the client.
                            // The IPC server in index.js will handle the actual dispatch and hijacking.
                            console.log(`[GeminiController] Suppressing redundant JSON-stream dispatch for tool: ${toolName}`);
                            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
                        }

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
                        const isResourceError = /RESOURCE_EXHAUSTED|rateLimitExceeded|429|No capacity available/i.test(stderrText);
                        const isPolicyError = /denied by policy|unauthorized tool call|not available to this agent/i.test(stderrText);

                        if (isAuthError) {
                            const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError({ type: 'error', message: errorMsg, code: 'AUTH_EXPIRED' });
                        } else if (isResourceError) {
                            const errorMsg = `Fatal: Gemini API Quota/Capacity Exhausted (429). Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError({ type: 'error', message: errorMsg, code: 'RATE_LIMIT' });
                        } else if (isPolicyError) {
                            const errorMsg = `Fatal: Tool use or action denied by policy. Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError({ type: 'error', message: errorMsg, code: 'POLICY_DENIED' });
                        }
                    }
                });

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    this.processes.delete(turnId);
                    // Skip immediate cleanup of callbacks to allow error handlers in catch block

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
        } finally {
            this.callbacksByTurn.delete(turnId);
        }
    }

    /**
     * Cancels a running process.
     */
    cancelCurrentTurn(turnId) {
        const proc = this.processes.get(turnId);
        if (proc) {
            console.log(`[GeminiController] Cancelling turn ${turnId}`);
            proc.kill('SIGINT');
            // Fallback for unresponsive CLI
            setTimeout(() => {
                if (this.processes.has(turnId)) {
                    console.warn(`[GeminiController] Turn ${turnId} unresponsive to SIGINT, sending SIGKILL.`);
                    try { proc.kill('SIGKILL'); } catch (_) { }
                }
            }, 2000);
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

