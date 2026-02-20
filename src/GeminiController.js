import { spawn } from 'child_process';
import EventEmitter from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { ContextDiffer } from './ContextDiffer.js';

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

export class GeminiController extends EventEmitter {
    constructor(cwd = process.cwd()) {
        super();
        this.cwd = cwd;
        this.process = null;
        this.accumulator = new JsonlAccumulator();
        this.ready = false;
        this.tempDir = path.join(this.cwd, 'temp');

        // Concurrency and GC state
        this.state = 'IDLE';
        this.promptQueue = Promise.resolve();
        this.currentTurnDeferred = null;
        this.currentPromptFiles = [];
        this.mutexTimeout = null;

        // Context Differ: strips redundant history from stateless clients
        this.differ = new ContextDiffer();

        // Ensure temp dir exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        this.accumulator.on('line', (json) => this._onLine(json));
    }

    spawn() {
        const cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
        const settingsPath = process.env.GEMINI_SETTINGS_JSON || path.join(os.homedir(), '.gemini', 'settings.json');

        this.process = spawn(cliPath, ['--headless', '--output-format', 'stream-json'], {
            cwd: this.cwd,
            env: {
                ...process.env,
                GEMINI_SETTINGS_JSON: settingsPath
            },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process.stdout.on('data', (chunk) => {
            // The CLI outputs a prompt '>' when ready for stdin
            if (!this.ready && chunk.toString().trim() === '>') {
                this.ready = true;
                this.emit('ready');
                return;
            }
            this.accumulator.push(chunk);
        });

        this.process.stderr.on('data', (chunk) => {
            const stderrText = chunk.toString().trim();
            console.error(`[Gemini CLI STDERR] ${stderrText}`);

            // The Auth Expiry Bomb Trap
            if (/(please log in|auth|authorization|credentials)/i.test(stderrText)) {
                const errorMsg = `Fatal: CLI Auth Expired or Missing. Requires re-authentication. Raw: ${stderrText}`;
                console.error(errorMsg);
                this.emit('error', { type: 'error', message: errorMsg, code: 'AUTH_EXPIRED' });
            }
        });

        this.process.on('close', (code) => {
            if (this.currentTurnDeferred) {
                this.currentTurnDeferred.reject(new Error(`Process closed with code ${code}`));
                this.currentTurnDeferred = null;
            }
            this.emit('close', code);
        });

        this.process.on('error', (err) => {
            if (this.currentTurnDeferred) {
                this.currentTurnDeferred.reject(new Error(`Process error: ${err.message}`));
                this.currentTurnDeferred = null;
            }
            this.emit('error', err);
        });
    }

    cancelCurrentTurn() {
        if (this.state === 'PROCESSING') {
            console.warn("[GeminiController] Cancelling current turn via SIGINT");
            this.state = 'CANCELLING';
            if (this.process) {
                this.process.kill('SIGINT');
            }
        }
    }

    _onLine(json) {
        if (json.type === 'text') {
            this.emit('text', json.value);
        } else if (json.type === 'toolCall') {
            this.emit('toolCall', json);
        } else if (json.type === 'error') {
            this.emit('error', json);
        } else if (json.type === 'result') {
            // Notify the differ that a full round-trip has completed.
            this.differ.recordResponse();
            this.emit('result', json);
            if (this.currentTurnDeferred) {
                this.currentTurnDeferred.resolve();
                this.currentTurnDeferred = null;
            }
        } else if (json.type === 'done') {
            this.emit('done');
        } else {
            this.emit('event', json);
        }
    }

    waitForReady() {
        if (this.ready) return Promise.resolve();
        return new Promise((resolve) => {
            this.once('ready', resolve);
        });
    }

    /**
     * Injects an external file into the temp directory and returns the `@temp_file_path` reference.
     */
    injectFile(sourcePath) {
        const fileName = path.basename(sourcePath);
        const destPath = path.join(this.tempDir, fileName);
        fs.copyFileSync(sourcePath, destPath);
        this.currentPromptFiles.push(destPath);
        return `@${destPath}`;
    }

    /**
     * Sends a prompt to the CLI via a temporary file piped to stdin to bypass OS limits.
     * Ensures prompts are queued so the CLI doesn't hallucinate overlapping inputs.
     * Includes a 5-minute timeout to prevent permanent deadlocks.
     */
    sendPrompt(text) {
        if (!this.process) throw new Error("CLI not running");

        this.promptQueue = this.promptQueue.then(async () => {
            this.state = 'PROCESSING';
            try {
                await new Promise((resolve, reject) => {
                    this.currentTurnDeferred = { resolve, reject };

                    // 5-minute Mutex Death Timer
                    this.mutexTimeout = setTimeout(() => {
                        console.error("[Mutex] Turn timed out after 5 minutes. Forcing release.");
                        if (this.currentTurnDeferred) {
                            this.currentTurnDeferred.reject(new Error("Turn timed out"));
                            this.currentTurnDeferred = null;
                        }
                    }, 5 * 60 * 1000);

                    const tempPromptPath = path.join(this.tempDir, `prompt-${randomUUID()}.txt`);

                    // Strip redundant history from stateless clients via LCP diff
                    const delta = this.differ.extractDelta(text);
                    if (!delta) {
                        console.warn('[ContextDiffer] Delta was empty — nothing new to send. Releasing mutex.');
                        resolve();
                        return;
                    }

                    fs.writeFileSync(tempPromptPath, delta, 'utf-8');
                    this.currentPromptFiles.push(tempPromptPath);

                    // Write the `@filepath` to stdin and a newline to submit
                    const command = `@${tempPromptPath}\n`;
                    this.process.stdin.write(command);
                });
            } finally {
                // Garbage Collection and Cleanup
                if (this.mutexTimeout) {
                    clearTimeout(this.mutexTimeout);
                    this.mutexTimeout = null;
                }

                for (const file of this.currentPromptFiles) {
                    try {
                        if (fs.existsSync(file)) fs.unlinkSync(file);
                    } catch (err) {
                        console.error(`[GC] Failed to delete temp file ${file}:`, err);
                    }
                }
                this.currentPromptFiles = [];
                this.state = 'IDLE';
            }
        }).catch(err => {
            console.error(`[Queue Error] ${err.message}`);
        });
    }

    destroy() {
        if (this.process) {
            this.process.kill();
        }
        // Cleanup temp files
        if (fs.existsSync(this.tempDir)) {
            try {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            } catch (e) {
                console.error(`Failed to cleanup temp dir: ${e}`);
            }
        }
    }
}
