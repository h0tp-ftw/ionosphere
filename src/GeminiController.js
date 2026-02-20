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
export class GeminiController extends EventEmitter {
    constructor(cwd = process.cwd()) {
        super();
        this.cwd = cwd;
        this.tempDir = path.join(this.cwd, 'temp');

        // Session mode: 'stateless' (fresh every time) or 'stateful' (LCP-based resume)
        this.sessionMode = (process.env.SESSION_MODE || 'stateless').toLowerCase();

        // Session Router: only instantiated in stateful mode
        this.router = this.sessionMode === 'stateful'
            ? new SessionRouter(path.join(this.tempDir, 'sessions.json'))
            : null;

        // Concurrency: serialize prompts so we don't overlap CLI invocations
        this.promptQueue = Promise.resolve();
        this.currentProcess = null;

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
     * @param {string} text - The full conversation payload from the client.
     * @returns {Promise<void>}
     */
    sendPrompt(text) {
        this.promptQueue = this.promptQueue.then(async () => {
            try {
                // 1. Route: find the right session (or skip in stateless mode)
                let sessionId = null, delta = text, isNew = true;
                if (this.sessionMode === 'stateful') {
                    ({ sessionId, delta, isNew } = this.router.route(text));
                }

                if (!delta) {
                    console.warn('[GeminiController] Delta was empty — nothing new to send.');
                    this.emit('result', { type: 'result', value: '' });
                    return;
                }

                // 2. Build CLI args
                const cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
                const settingsPath = process.env.GEMINI_SETTINGS_JSON || path.join(process.cwd(), '.gemini', 'settings.json');

                const args = [];

                if (!isNew && sessionId) {
                    args.push('--resume', sessionId);
                }

                // Write delta to a temp file to avoid shell escaping issues and OS arg limits
                const tempPromptPath = path.join(this.tempDir, `prompt-${randomUUID()}.txt`);
                fs.writeFileSync(tempPromptPath, delta, 'utf-8');

                // Use -p with @file reference for the prompt content
                args.push('-p', `@${tempPromptPath}`);
                args.push('-o', 'stream-json');

                console.log(`[GeminiController] Spawning CLI [${this.sessionMode}]: ${cliPath} ${args.join(' ')}`);
                console.log(`[GeminiController] Session: ${isNew ? 'NEW' : sessionId}, Delta: ${delta.length} chars`);

                // 3. Spawn the one-shot process
                const result = await new Promise((resolve, reject) => {
                    const accumulator = new JsonlAccumulator();
                    let lastResultJson = null;

                    const proc = spawn(cliPath, args, {
                        cwd: this.cwd,
                        env: {
                            ...process.env,
                            GEMINI_SETTINGS_JSON: settingsPath,
                        },
                        stdio: ['pipe', 'pipe', 'pipe'],
                        shell: process.platform === 'win32',
                    });

                    this.currentProcess = proc;

                    // 5-minute timeout
                    const timeout = setTimeout(() => {
                        console.error('[GeminiController] Process timed out after 5 minutes. Killing.');
                        proc.kill();
                        reject(new Error('Turn timed out'));
                    }, 5 * 60 * 1000);

                    accumulator.on('line', (json) => {
                        if (json.type === 'text') {
                            this.emit('text', json.value);
                        } else if (json.type === 'toolCall') {
                            this.emit('toolCall', json);
                        } else if (json.type === 'error') {
                            this.emit('error', json);
                        } else if (json.type === 'result') {
                            lastResultJson = json;
                            this.emit('result', json);
                        } else if (json.type === 'done') {
                            this.emit('done');
                        } else {
                            this.emit('event', json);
                        }
                    });

                    proc.stdout.on('data', (chunk) => {
                        accumulator.push(chunk);
                    });

                    proc.stderr.on('data', (chunk) => {
                        const stderrText = chunk.toString().trim();
                        if (stderrText) {
                            console.error(`[Gemini CLI STDERR] ${stderrText}`);

                            if (/(please log in|auth|authorization|credentials)/i.test(stderrText)) {
                                const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
                                console.error(errorMsg);
                                this.emit('error', { type: 'error', message: errorMsg, code: 'AUTH_EXPIRED' });
                            }
                        }
                    });

                    proc.on('close', (code) => {
                        clearTimeout(timeout);
                        this.currentProcess = null;

                        if (code === 0) {
                            resolve(lastResultJson);
                        } else {
                            reject(new Error(`CLI process exited with code ${code}`));
                        }
                    });

                    proc.on('error', (err) => {
                        clearTimeout(timeout);
                        this.currentProcess = null;
                        reject(new Error(`Failed to spawn CLI: ${err.message}`));
                    });
                });

                // 4. After success, discover the session ID and record the turn (stateful only)
                if (this.sessionMode === 'stateful') {
                    if (isNew) {
                        // Discover the new session ID by listing sessions
                        const newSessionId = await this._discoverLatestSessionId();
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
                this.emit('error', { type: 'error', message: err.message });
            }
        }).catch(err => {
            console.error(`[Queue Error] ${err.message}`);
        });

        return this.promptQueue;
    }

    /**
     * Discovers the most recently created session ID by calling `gemini --list-sessions`.
     * Parses the output to extract the session UUID.
     *
     * @returns {Promise<string|null>} The session ID or null if discovery failed.
     */
    async _discoverLatestSessionId() {
        try {
            const cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
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
     */
    cancelCurrentTurn() {
        if (this.currentProcess) {
            console.warn('[GeminiController] Cancelling current turn via SIGINT');
            this.currentProcess.kill('SIGINT');
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
     * Cleanup temp directory.
     */
    destroy() {
        if (this.currentProcess) {
            this.currentProcess.kill();
        }
        if (fs.existsSync(this.tempDir)) {
            try {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            } catch (e) {
                console.error(`Failed to cleanup temp dir: ${e}`);
            }
        }
    }
}
