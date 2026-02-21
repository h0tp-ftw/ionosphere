import { spawn } from 'child_process';
import EventEmitter from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { SessionRouter } from './SessionRouter.js';

/**
 * Accumulates chunked stdout into distinct JSON lines.
 * Useful for OS pipe fragmentation where a single JSON object spans multiple buffer reads.
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
 * GeminiController — One-Shot Per-Prompt CLI Spawner
 *
 * Instead of maintaining a persistent CLI REPL, this controller spawns a new
 * `gemini` process for each prompt using one-shot mode (`-p` flag).
 *
 * For session continuation, it uses `--resume <sessionId>` to restore context
 * from a prior session. The SessionRouter determines which session to resume
 * (or whether to start a new one) using LCP matching.
 */
export class GeminiController {
    constructor(cwd = process.cwd()) {
        this.cwd = cwd;
        this.tempDir = path.join(this.cwd, 'temp');

        // Session mode: 'stateless' (fresh every time) or 'stateful' (LCP-based resume)
        this.sessionMode = (process.env.SESSION_MODE || 'stateless').toLowerCase();

        // Session Router: only instantiated in stateful mode
        this.router = this.sessionMode === 'stateful'
            ? new SessionRouter(path.join(this.tempDir, 'sessions.db'))
            : null;

        this.processes = new Map();

        // Ensure temp dir exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Sends a prompt through the session-aware pipeline:
     * 1. Route the payload via SessionRouter to find the right session
     * 2. Spawn `gemini --resume <id> -p <delta> -o stream-json` (or no --resume for new sessions)
     * 3. Stream output events back via EventEmitter
     * 4. After completion, discover/record the session ID
     *
     * @param {string} turnId - The unique ID for this turn.
     * @param {string} text - The full conversation payload from the client.
     * @param {string} workspacePath - The isolated directory to run this turn in.
     * @param {string} settingsPath - The isolated settings.json to use for this turn.
     * @param {string} systemPrompt - Optional system prompt to use for this turn.
     * @param {Object} callbacks - Functions to process output chunks.
     * @returns {Promise<void>}
     */
    async sendPrompt(turnId, text, workspacePath = this.cwd, settingsPath = process.env.GEMINI_SETTINGS_JSON || path.join(this.cwd, '.gemini', 'settings.json'), systemPrompt = null, callbacks = {}) {
        try {
            // 1. Route: find the right session (or skip in stateless mode)
            let sessionId = null, delta = text, isNew = true;
            if (this.sessionMode === 'stateful') {
                ({ sessionId, delta, isNew } = this.router.route(text));
            }

            if (!delta) {
                console.warn(`[GeminiController] Turn ${turnId}: Delta was empty — nothing new to send.`);
                if (callbacks.onResult) callbacks.onResult({ type: 'result', value: '' });
                return;
            }

            // 2. Build CLI args
            let cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
            if (process.platform === 'win32' && !cliPath.endsWith('.cmd') && !cliPath.endsWith('.exe')) {
                cliPath += '.cmd';
            }

            // -y skips all interactive trust prompts for the isolated workspace
            const args = ['-y'];

            if (!isNew && sessionId) {
                args.push('--resume', sessionId);
            }

            // Write delta to the isolated workspace
            const tempPromptPath = path.join(workspacePath, `prompt-${randomUUID()}.txt`);
            fs.writeFileSync(tempPromptPath, delta, 'utf-8');

            args.push('-o', 'stream-json');
            args.push('-p', `@${tempPromptPath}`);

            // Handle System Prompt if provided
            let systemPromptPath = null;
            if (systemPrompt) {
                systemPromptPath = path.join(workspacePath, 'system.md');
                fs.writeFileSync(systemPromptPath, systemPrompt, 'utf-8');
            }

            console.log(`[GeminiController] Spawning CLI [${this.sessionMode}]: ${cliPath} ${args.join(' ')}`);
            if (systemPrompt) console.log(`[GeminiController] System Prompt: ${systemPrompt.length} chars`);
            console.log(`[GeminiController] Session: ${isNew ? 'NEW' : sessionId}, Delta: ${delta.length} chars`);
            console.log(`[GeminiController] Workspace: ${workspacePath}`);

            // 3. Spawn the one-shot process
            const result = await new Promise((resolve, reject) => {
                const accumulator = new JsonlAccumulator();
                let lastResultJson = null;

                const spawnEnv = {
                    ...process.env,
                    GEMINI_SETTINGS_JSON: settingsPath,
                };

                // Inject System Prompt override if applicable
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

                // 5-minute timeout
                const timeout = setTimeout(() => {
                    console.error('[GeminiController] Process timed out after 5 minutes. Killing.');
                    proc.kill();
                    reject(new Error('Turn timed out'));
                }, 5 * 60 * 1000);

                accumulator.on('line', (json) => {
                    if (json.type === 'text') {
                        if (callbacks.onText) callbacks.onText(json.value);
                    } else if (json.type === 'toolCall') {
                        if (callbacks.onToolCall) callbacks.onToolCall(json);
                    } else if (json.type === 'error') {
                        if (callbacks.onError) callbacks.onError(json);
                    } else if (json.type === 'result') {
                        lastResultJson = json;
                        if (callbacks.onResult) callbacks.onResult(json);
                    } else if (json.type === 'done') {
                        if (callbacks.onDone) callbacks.onDone();
                    } else {
                        if (callbacks.onEvent) callbacks.onEvent(json);
                    }
                });

                proc.stdout.on('data', (chunk) => {
                    accumulator.push(chunk);
                });

                proc.stderr.on('data', (chunk) => {
                    const stderrText = chunk.toString().trim();
                    if (stderrText) {
                        console.error(`[Gemini CLI STDERR] ${stderrText}`);

                        const isAuthError = (/(please log in|auth|authorization)/i.test(stderrText) && !/unauthorized tool call/i.test(stderrText)) ||
                            (/credentials/i.test(stderrText) && !/loaded cached credentials/i.test(stderrText));

                        if (isAuthError) {
                            const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
                            console.error(errorMsg);
                            if (callbacks.onError) callbacks.onError({ type: 'error', message: errorMsg, code: 'AUTH_EXPIRED' });

                            if (process.env.WEBHOOK_URL) {
                                fetch(process.env.WEBHOOK_URL, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        content: "🚨 **Gemini Ionosphere Alert** 🚨\nThe underlying Gemini CLI Authentication has expired or is missing. Please SSH into the container and run `gemini login`."
                                    })
                                }).catch(err => console.error(`[Webhook Failed] ${err.message}`));
                            }
                        }
                    }
                });

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    this.processes.delete(turnId);

                    if (code === 0) {
                        resolve(lastResultJson);
                    } else {
                        reject(new Error(`CLI process exited with code ${code}`));
                    }
                });

                proc.on('error', (err) => {
                    clearTimeout(timeout);
                    this.processes.delete(turnId);
                    reject(new Error(`Failed to spawn CLI: ${err.message}`));
                });
            });

            // 4. After success, discover the session ID and record the turn (stateful only)
            if (this.sessionMode === 'stateful') {
                if (isNew) {
                    // Discover the new session ID by listing sessions from the isolated workspace
                    const newSessionId = await this._discoverLatestSessionId(workspacePath);
                    if (newSessionId) {
                        this.router.registerSession(newSessionId, text);
                    } else {
                        console.warn('[GeminiController] Could not discover new session ID. Session will not be resumable.');
                    }
                } else {
                    // Update existing session with the new cumulative payload
                    this.router.recordTurn(sessionId, text);
                }
            }

            // Clean up temp prompt file
            try {
                if (fs.existsSync(tempPromptPath)) fs.unlinkSync(tempPromptPath);
            } catch (err) {
                console.error(`[GC] Failed to delete temp file ${tempPromptPath}:`, err);
            }

        } catch (err) {
            console.error(`[GeminiController] Turn error: ${err.message}`);
            if (callbacks.onError) callbacks.onError({ type: 'error', message: err.message });
        }
    }

    /**
     * Discovers the most recently created session ID by calling `gemini --list-sessions`.
     * Parses the output to extract the session UUID.
     *
     * @returns {Promise<string|null>} The session ID or null if discovery failed.
     */
    async _discoverLatestSessionId() {
        try {
            let cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
            if (process.platform === 'win32' && !cliPath.endsWith('.cmd') && !cliPath.endsWith('.exe')) {
                cliPath += '.cmd';
            }
            const output = await new Promise((resolve, reject) => {
                let stdout = '';
                const proc = spawn(cliPath, ['--list-sessions'], {
                    cwd: this.cwd,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: process.platform === 'win32',
                });

                proc.stdout.on('data', (chunk) => {
                    stdout += chunk.toString();
                });

                proc.on('close', (code) => {
                    resolve(stdout);
                });

                proc.on('error', (err) => {
                    reject(err);
                });
            });

            // Parse session listing output.
            // Typical format from gemini --list-sessions:
            //   1. [2026-02-19] a1b2c3d4-e5f6-7890-abcd-ef1234567890 - "Hello..."
            // We want the UUID from the most recent (last listed or first listed) entry.
            const uuidRegex = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
            const uuids = output.match(uuidRegex);

            if (uuids && uuids.length > 0) {
                // Take the last UUID listed (most recent)
                const latestId = uuids[uuids.length - 1];
                console.log(`[GeminiController] Discovered new session ID: ${latestId}`);
                return latestId;
            }

            // Fallback: try to extract numeric index
            const indexRegex = /^\s*(\d+)\./m;
            const indexMatch = output.match(indexRegex);
            if (indexMatch) {
                console.log(`[GeminiController] Discovered session index: ${indexMatch[1]}`);
                return indexMatch[1];
            }

            console.warn(`[GeminiController] Could not parse session ID from output: ${output}`);
            return null;
        } catch (err) {
            console.error(`[GeminiController] Failed to list sessions: ${err.message}`);
            return null;
        }
    }

    /**
     * Cancels the currently running CLI process via SIGINT.
     * @param {string} turnId 
     */
    cancelCurrentTurn(turnId) {
        const proc = this.processes.get(turnId);
        if (proc) {
            console.warn(`[GeminiController] Cancelling turn ${turnId} via SIGINT`);
            proc.kill('SIGINT');
            this.processes.delete(turnId);
        }
    }

    /**
     * Injects an external file into the temp directory and returns the `@temp_file_path` reference.
     */
    injectFile(sourcePath) {
        const fileName = path.basename(sourcePath);
        const destPath = path.join(this.tempDir, fileName);
        fs.copyFileSync(sourcePath, destPath);
        return `@${destPath}`;
    }

    /**
     * Cleanup processes gracefully on exit.
     */
    destroyAll() {
        for (const [turnId, proc] of this.processes.entries()) {
            try {
                proc.kill('SIGKILL');
            } catch (e) {
                console.error(`Failed to kill process for turn ${turnId}: ${e}`);
            }
        }
        this.processes.clear();
    }
}
