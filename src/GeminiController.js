import { spawn } from 'child_process';
import EventEmitter from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { createError, ErrorType, ErrorCode } from './errorHandler.js';

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
    updateCallbacks(turnId, callbacks, extraEnv = null) {
        const previous = this.callbacksByTurn.has(turnId);
        this.callbacksByTurn.set(turnId, callbacks);

        if (extraEnv) {
            const proc = this.processes.get(turnId);
            if (proc) {
                // Sync historical context into the running process tracker
                proc.extraEnv = { ...(proc.extraEnv || {}), ...extraEnv };
            }
        }

        if (previous) {
            console.log(`[GeminiController] Callbacks ${extraEnv ? 'AND extraEnv ' : ''}HIJACKED for turn ${turnId}`);
        } else {
            console.warn(`[GeminiController] Callbacks registered for INACTIVE turn ${turnId}`);
        }
    }

    /**
     * Executes a strictly stateless CLI turn.
     * 1. Spawn `gemini -y -o stream-json -p <text> --settings <settingsPath>`
     * 2. Stream output events back via callbacks.
     */
    async sendPrompt(turnId, text, workspacePath = this.cwd, settingsPath = process.env.GEMINI_SETTINGS_JSON || path.join(this.cwd, '.gemini', 'settings.json'), systemPrompt = null, callbacks = {}, extraEnv = {}, attachments = []) {
        try {
            this.callbacksByTurn.set(turnId, callbacks);

            const args = ['-y', '-o', 'stream-json'];

            // Write prompt to a temp file
            const tempPromptPath = path.join(workspacePath, `prompt-${randomUUID()}.txt`);
            fs.writeFileSync(tempPromptPath, text, 'utf-8');

            // Pass attachments and the prompt file via the -p flag.
            // Gemini CLI resolves @references in the positional query argument if joined.
            const promptRefs = [...attachments, tempPromptPath].map(p => `@${p}`).join(' ');
            args.push('-p', promptRefs);

            let systemPromptPath = null;
            if (systemPrompt !== null) {
                systemPromptPath = path.join(workspacePath, 'system.md');
                fs.writeFileSync(systemPromptPath, systemPrompt, 'utf-8');
            }

            // Persistence for debugging
            if (process.env.GEMINI_DEBUG_PROMPTS === 'true') {
                const debugDir = path.join(this.cwd, 'debug_prompts');
                if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                fs.copyFileSync(tempPromptPath, path.join(debugDir, `turn-${turnId}-prompt.txt`));
                if (systemPromptPath) {
                    fs.copyFileSync(systemPromptPath, path.join(debugDir, `turn-${turnId}-system.md`));
                }
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
                    GEMINI_PROMPT_AGENTSKILLS: '0',
                    GEMINI_PROMPT_AGENTCONTEXTS: '0',
                    ...extraEnv
                };

                if (systemPromptPath) {
                    spawnEnv.GEMINI_SYSTEM_MD = systemPromptPath;
                }

                if (process.env.GEMINI_DEBUG_PROMPTS === 'true') {
                    const hijackedFrom = this.callbacksByTurn.get(turnId)?.hijackedFrom;
                    const context = hijackedFrom ? ` (Hijacked from ${hijackedFrom})` : "";
                    console.log(`[GeminiController] TURN=${turnId}${context} PROMPT_FILE=${tempPromptPath} HASH=${extraEnv.IONOSPHERE_HISTORY_HASH || 'none'}`);
                    try {
                        const raw = fs.readFileSync(tempPromptPath, 'utf8');
                        console.log(`[GeminiController] RAW PROMPT (First 500 chars):\n${raw.substring(0, 500)}...`);
                    } catch (_) { }
                }

                const proc = spawn(executable, finalArgs, {
                    cwd: workspacePath,
                    env: spawnEnv,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: process.platform === 'win32',
                });

                proc.extraEnv = extraEnv; // Initialize with spawn env
                proc.toolUsage = new Set(); // Track real tool calls in this turn
                this.processes.set(turnId, proc);

                // 2-hour timeout for ReAct loops (human-in-the-loop scale)
                const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS) || 120 * 60 * 1000;
                const timeout = setTimeout(() => {
                    console.error(`[GeminiController] FATAL: Turn ${turnId} timed out after ${TURN_TIMEOUT_MS / 60000}m. Active tools: ${Array.from(proc.toolUsage).join(', ')}. Killing process.`);
                    proc.kill('SIGKILL');
                    reject(new Error(`Turn timed out after ${TURN_TIMEOUT_MS / 60000}m`));
                }, TURN_TIMEOUT_MS);

                const checkRepeatLimit = (toolName, argsObj, activeCallbacks) => {
                    const currentEnv = proc?.extraEnv || extraEnv;
                    if (!currentEnv.IONOSPHERE_HISTORY_HASH) return false;
                    const hash = currentEnv.IONOSPHERE_HISTORY_HASH;

                    // Scope repeat tracker to the process/turn to prevent persistence bugs on retries
                    if (!proc.repeatTracker) proc.repeatTracker = new Map();

                    // Normalize toolName to be prefix-agnostic for loop tracking
                    const normalizedToolName = toolName.startsWith('ionosphere__') ? toolName.slice(12) : toolName;
                    const toolArgs = JSON.stringify(argsObj || {});
                    const key = `${hash}:${normalizedToolName}:${toolArgs}`;

                    // Check if this is a "historical" tool call being parroted
                    const isHistorical = (currentEnv.IONOSPHERE_HISTORY_TOOLS || "").includes(key);

                    if (isHistorical) {
                        console.log(`[GeminiController] [FORENSICS] Tool '${toolName}' with args ${toolArgs} identified as historical echo (Key: ${key.substring(0, 15)}...). Ignoring.`);
                        return true; // Ignore historical echoes
                    }

                    const count = (proc.repeatTracker.get(key) || 0) + 1;
                    proc.repeatTracker.set(key, count);
                    console.log(`[GeminiController] [FORENSICS] Repeat Tracker: ${toolName} count=${count} for key ${key.substring(0, 15)}...`);

                    const maxRepeats = parseInt(process.env.MAX_REPEAT_TOOL_CALLS) || 0;

                    if (maxRepeats > 0 && count >= maxRepeats) {
                        console.error(`[GeminiController] Repeat Breaker: Tool '${toolName}' called ${count} times within the same Turn. Terminating process to prevent loop.`);
                        const errorMsg = `Loop detected: Model repeated tool '${toolName}' with same arguments ${count} times. Terminating for safety. (Limit: ${maxRepeats})`;
                        if (activeCallbacks.onError) activeCallbacks.onError(createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.POLICY_DENIED));
                        if (activeCallbacks.onResult) activeCallbacks.onResult({ type: 'result', text: errorMsg, stats: {} });
                        proc.kill();
                        return 'KILL';
                    }
                    return false;
                };

                accumulator.on('line', (json) => {
                    const activeCallbacks = this.callbacksByTurn.get(turnId) || {};

                    if (process.env.GEMINI_DEBUG_RAW === 'true') {
                        console.log(`[Turn ${turnId}] CLI Raw Line: ${JSON.stringify(json)}`);
                    } else {
                        console.log(`[Turn ${turnId}] CLI Raw Line: ${json.type}${json.role ? ' [' + json.role + ']' : ''}`);
                    }

                    if (json.type === 'message' && json.role === 'assistant') {
                        const content = (typeof json.content === 'object') ? json.content.text : json.content;
                        if (content) {
                            // Intercept "leaked" tool calls that the model might write as text heritage
                            // NEW FORMAT: <action id="...">Called tool '...' with args: ...</action>
                            const actionRegex = /<action id="([^"]*)">Called tool '([^']+)' with args: (.*?)<\/action>/gs;
                            const resultRegex = /<result id="([^"]*)">([\s\S]*?)<\/result>/gs;
                            let match;
                            let cleanedContent = content;

                            while ((match = actionRegex.exec(content)) !== null) {
                                const [fullMatch, callId, toolName, argsStr] = match;

                                // HACK: Only dispatch the leak if we HAVEN'T already seen a real tool call for this name in this turn
                                // This prevents the "Echo Loop" where history narration triggers a new call.
                                const alreadySeen = Array.from(this.processes.get(turnId)?.toolUsage || []).includes(toolName);
                                const isLikelyHallucination = !argsStr || argsStr.trim() === '{}' || argsStr.trim().length < 2;

                                if (!alreadySeen && !isLikelyHallucination) {
                                    if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                                        console.log(`[GeminiController] Intercepted leaked tool call in text for Turn ${turnId}: ${toolName} (${callId})`);
                                    }

                                    // Apply Repeat Breaker to leaks too!
                                    let parsedArgs = {};
                                    try { parsedArgs = JSON.parse(argsStr); } catch (e) { }
                                    if (checkRepeatLimit(toolName, parsedArgs) === 'KILL') return;

                                    if (activeCallbacks.onToolCall) {
                                        activeCallbacks.onToolCall({
                                            id: callId.startsWith('leak_') ? callId : `leak_${callId}`,
                                            name: toolName,
                                            arguments: argsStr.trim()
                                        });
                                    }
                                } else if (isLikelyHallucination) {
                                    if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                                        console.log(`[GeminiController] Ignoring likely hallucinated tool call leak: ${toolName} with args: ${argsStr}`);
                                    }
                                } else {
                                    if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                                        console.log(`[GeminiController] Suppressing echo-leak for tool '${toolName}' on Turn ${turnId}. (Already called in this turn)`);
                                    }
                                }
                            }

                            // Suppress echoed results as well
                            while ((match = resultRegex.exec(content)) !== null) {
                                if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                                    console.log(`[GeminiController] Suppressing echo-leak for result: ${match[1]}`);
                                }
                            }

                            // Remove both action and result tags from the text before sending it to the client
                            cleanedContent = content.replace(actionRegex, '').replace(resultRegex, '');
                            if (cleanedContent && activeCallbacks.onText) {
                                activeCallbacks.onText(cleanedContent);
                            }
                        }

                    } else if (json.type === 'tool_use' || json.type === 'toolCall') {
                        const toolName = json.tool_name || json.name;
                        const argsObj = json.arguments || {};

                        // Track real usage to suppress "echo leaks"
                        this.processes.get(turnId)?.toolUsage.add(toolName);

                        // Repeat Breaker Logic (Global per historyHash)
                        if (checkRepeatLimit(toolName, argsObj, activeCallbacks) === 'KILL') return;

                        const transparentTools = ['google_web_search'];
                        if (transparentTools.includes(toolName)) {
                            console.log(`[GeminiController] Transparently executing native tool: ${toolName}`);
                            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
                        } else {
                            // Non-transparent tools (MCP tools) are handled via the ionosphere-tool-bridge and IPC.
                            // We do NOT dispatch onToolCall here to avoid double-dispatching to the client.
                            // The IPC server in index.js will handle the actual dispatch and hijacking.
                            if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                                console.log(`[GeminiController] Suppressing redundant JSON-stream dispatch for tool: ${toolName} (Turn: ${turnId})`);
                            }
                            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
                        }

                    } else if (json.type === 'error') {
                        if (activeCallbacks.onError) activeCallbacks.onError(json);

                    } else if (json.type === 'result') {
                        lastResultJson = json;
                        if (json.stats) {
                            const { input_tokens, output_tokens, total_tokens } = json.stats;
                            console.log(`[GeminiController] Turn ${turnId} Usage: In=${input_tokens || 0}, Out=${output_tokens || 0}, Total=${total_tokens || 0}`);
                            if ((output_tokens || 0) === 0) {
                                console.warn(`[GeminiController] WARNING: Turn ${turnId} generated 0 tokens. This may indicate a safety block or context issue.`);
                            }
                        }
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

                let lastStderr = '';
                let lastStderrLines = [];
                proc.stderr.on('data', (chunk) => {
                    const stderrText = chunk.toString().trim();
                    if (stderrText) {
                        lastStderrLines.push(stderrText);
                        if (lastStderrLines.length > 5) lastStderrLines.shift();

                        lastStderr = stderrText.split('\n').slice(-3).join('\n'); // Keep last 3 lines
                        const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
                        console.error(`[Gemini CLI STDERR] [Turn ${turnId}] ${stderrText}`);

                        // ... (keep matches as they were)
                        const isAuthError = (/(please log in|\bauthorization\b|authenticate|not authenticated)/i.test(stderrText) && !/unauthorized tool call/i.test(stderrText)) ||
                            (/credentials/i.test(stderrText) && !/loaded cached credentials/i.test(stderrText));
                        const isResourceError = /RESOURCE_EXHAUSTED|rateLimitExceeded|429|No capacity available/i.test(stderrText);
                        const isPolicyError = /denied by policy|unauthorized tool call|not available to this agent/i.test(stderrText);
                        const isNotFound = /Tool "([^"]+)" not found/i.test(stderrText);
                        const isModelError = /ModelNotFoundError|entity was not found/i.test(stderrText);

                        if (isAuthError) {
                            const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError(createError(errorMsg, ErrorType.AUTHENTICATION, ErrorCode.INVALID_API_KEY));
                            proc.kill('SIGKILL');
                        } else if (isResourceError) {
                            const errorMsg = `Gemini API Quota/Capacity Exhausted (429). Raw: ${stderrText}`;
                            if (process.env.GEMINI_SILENT_FALLBACK === 'true') {
                                console.log(`[GeminiController] Seamless Fallback: Ignoring 429 error to allow internal CLI fallback.`);
                            } else {
                                console.error(`[GeminiController] Fatal Resource Error: Killing process.`);
                                if (activeCallbacks.onError) activeCallbacks.onError(createError(errorMsg, ErrorType.RATE_LIMIT, ErrorCode.RATE_LIMIT_EXCEEDED));
                                proc.kill('SIGKILL');
                            }
                        } else if (isModelError) {
                            const errorMsg = `Fatal: Model not found or inaccessible. Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError(createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.MODEL_NOT_FOUND));
                            proc.kill('SIGKILL');
                        } else if (isPolicyError) {
                            const errorMsg = `Fatal: Tool use or action denied by policy. Raw: ${stderrText}`;
                            if (activeCallbacks.onError) activeCallbacks.onError(createError(errorMsg, ErrorType.PERMISSION, ErrorCode.POLICY_DENIED));
                            proc.kill('SIGKILL');
                        } else if (isNotFound) {
                            const match = stderrText.match(/Tool "([^"]+)" not found/i);
                            const toolName = match ? match[1] : 'unknown';
                            const errorMsg = `Fatal: Tool "${toolName}" not found. This environment does not support ${toolName}.`;
                            console.log(`[GeminiController] Aggressively breaking loop: Tool '${toolName}' not found.`);

                            if (activeCallbacks.onEvent) {
                                activeCallbacks.onEvent({
                                    type: 'tool_result',
                                    tool_name: toolName,
                                    result: errorMsg,
                                    is_error: true
                                });
                            }
                            console.log(`[GeminiController] Soft error: Missing tool ${toolName} reported back to model.`);
                        }
                    }
                });

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    const usageSummary = Array.from(this.processes.get(turnId)?.toolUsage || []).join(', ') || 'none';
                    console.log(`[GeminiController] Process closed for turn ${turnId} with code ${code}. Tool Usage: [${usageSummary}]`);

                    if (accumulator.buffer) {
                        accumulator.push('\n');
                    }

                    this.processes.delete(turnId);

                    try {
                        if (fs.existsSync(tempPromptPath)) fs.unlinkSync(tempPromptPath);
                    } catch (_) { }

                    if (code === 0 || code === null) {
                        resolve(lastResultJson);
                    } else {
                        const diagnostics = lastStderrLines.join('\n').trim();
                        const errorMsg = diagnostics ? `CLI failed (code ${code}): ${diagnostics}` : `CLI process exited with code ${code}`;
                        reject(new Error(errorMsg));
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
            if (activeCallbacks.onError) activeCallbacks.onError(createError(err.message, ErrorType.SERVER, ErrorCode.INTERNAL_ERROR));
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

