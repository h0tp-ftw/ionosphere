import express from 'express';
import multer from 'multer';
import net from 'net';
import { GeminiController } from './GeminiController.js';
import fs from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { generateConfig } from '../scripts/generate_settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the tool-bridge MCP server entry point
const TOOL_BRIDGE_PATH = path.resolve(__dirname, '..', 'packages', 'tool-bridge', 'index.js');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Helper to sanitize user-provided text: escape lines starting with @ or !
const sanitizePromptText = (text) => {
    if (typeof text !== 'string') return text;
    return text.split('\n').map(line => {
        if (line.startsWith('@') || line.startsWith('!')) {
            return '\\' + line;
        }
        return line;
    }).join('\n');
};

/**
 * Computes a hash of the conversation messages to identify a thread.
 */
const getHistoryHash = (messages) => {
    const serialized = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content, name: m.name, tool_call_id: m.tool_call_id })));
    return createHash('sha256').update(serialized).digest('hex');
};

// Ensure base temp directory exists
const baseTempDir = path.join(process.cwd(), 'temp');
if (!fs.existsSync(baseTempDir)) {
    fs.mkdirSync(baseTempDir, { recursive: true });
}

// Setup multer so files stream directly into our per-request isolated temp/ directory
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Initialize turnId early if it doesn't exist
        if (!req.turnId) {
            req.turnId = randomUUID();
        }
        const turnTempDir = path.join(baseTempDir, req.turnId);
        if (!fs.existsSync(turnTempDir)) {
            fs.mkdirSync(turnTempDir, { recursive: true });
        }
        cb(null, turnTempDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });

const PORT = process.env.PORT || 3000;

const sessionMode = process.env.SESSION_MODE || 'stateless';
console.log(`Starting Gemini Ionosphere (${sessionMode === 'stateful' ? 'Session-Aware' : 'Stateless'} Mode)...`);
const controller = new GeminiController();

// Global state for Warm Stateless Handoff
// pendingToolCalls: callKey -> { socket, turnId }
const pendingToolCalls = new Map();
// parkedTurns: turnId -> { controller, executePromise, resolveTask, cleanupWorkspace, historyHash }
const parkedTurns = new Map();
// activeTurnsByHash: historyHash -> turnId (to prevent duplicate CLI for same thread)
const activeTurnsByHash = new Map();
// globalPromiseMap: turnId -> executePromise
const globalPromiseMap = new Map();

const MAX_CONCURRENT_CLI = parseInt(process.env.MAX_CONCURRENT_CLI) || 5;
let currentlyRunning = 0;
const requestQueue = [];

// Helper: resolve a pending tool call with a result string.
// If the callKey matches a parked turn, it unblocks the CLI logic.
const resolveToolCall = (callKey, result) => {
    const pending = pendingToolCalls.get(callKey);
    if (!pending) {
        console.warn(`[IPC] resolveToolCall: No pending call for ${callKey}`);
        return false;
    }
    pendingToolCalls.delete(callKey);
    try {
        console.log(`[IPC] Sending result to turn ${pending.turnId} for tool ${callKey}`);
        pending.socket.write(JSON.stringify({ event: 'tool_result', result: String(result) }) + '\n');
        pending.socket.end();
        console.log(`[IPC] Resolved tool call ${callKey} for turn ${pending.turnId}`);
    } catch (e) {
        console.error('[IPC] Failed to write tool result:', e.message);
    }
    return true;
};

async function enqueueControllerPrompt(executeTask) {
    if (currentlyRunning >= MAX_CONCURRENT_CLI) {
        await new Promise(resolve => requestQueue.push(resolve));
    }
    currentlyRunning++;
    console.log(`[Queue] CLI started. Active: ${currentlyRunning}/${MAX_CONCURRENT_CLI}, Parked: ${parkedTurns.size}, Queue: ${requestQueue.length}`);
    try {
        await executeTask();
    } finally {
        currentlyRunning--;
        if (requestQueue.length > 0) {
            const next = requestQueue.shift();
            next();
        }
    }
}

// Garbage Collector: Force-delete temp/ directories older than 15 minutes
setInterval(() => {
    try {
        if (fs.existsSync(baseTempDir)) {
            const now = Date.now();
            const entries = fs.readdirSync(baseTempDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dirPath = path.join(baseTempDir, entry.name);
                    const stats = fs.statSync(dirPath);
                    if (now - stats.mtimeMs > 15 * 60 * 1000) {
                        // Check if turn is still parked
                        if (!parkedTurns.has(entry.name)) {
                            console.log(`[GC] Sweeping abandoned workspace: ${entry.name}`);
                            fs.rmSync(dirPath, { recursive: true, force: true });
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error(`[GC] Sweeper error:`, e);
    }
}, 5 * 60 * 1000); // Run every 5 minutes

// Process Safety
process.on('SIGINT', () => { controller.destroyAll(); process.exit(0); });
process.on('SIGTERM', () => { controller.destroyAll(); process.exit(0); });

const handleUpload = (req, res, next) => {
    if (req.is('multipart/form-data')) {
        upload.any()(req, res, next);
    } else {
        next();
    }
};

app.post('/v1/chat/completions', handleUpload, async (req, res) => {
    try {
        // 1. Authorization
        const expectedApiKey = process.env.API_KEY;
        if (expectedApiKey) {
            const authHeader = req.headers['authorization'];
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                console.log("[API] Auth Failed: Missing header");
                return res.status(401).json({ error: { message: "Missing or formatted improperly Authorization header." } });
            }
            if (authHeader.substring(7) !== expectedApiKey) {
                console.log("[API] Auth Failed: Invalid key");
                return res.status(401).json({ error: { message: "Invalid API Key" } });
            }
        }

        let messages = req.body.messages;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: "Missing 'messages' array" });
        }

        const historyHash = getHistoryHash(messages);

        // 2. Identify "Handoff" (Warm Stateless Continuity)
        // If the last message is a TOOL result, check if we have a parked turn for it.
        let lastMsg = messages[messages.length - 1];
        let hijackedTurnId = null;
        if (lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function')) {
            const callId = lastMsg.tool_call_id;
            const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;

            if (process.env.GEMINI_DEBUG_HANDOFF === 'true') {
                console.log(`[Handoff] Attempting match for callId: ${callId}, shortKey: ${shortKey}, pending: ${pendingToolCalls.size}`);
            }

            // Find the full callKey in pendingToolCalls
            for (const [callKey, pending] of pendingToolCalls.entries()) {
                if (callKey.startsWith(shortKey)) {
                    hijackedTurnId = pending.turnId;
                    console.log(`[API] Hijack discovery: Match found for ${callId} -> Turn ${hijackedTurnId}`);
                    break;
                }
            }
            if (!hijackedTurnId) {
                console.log(`[API] Hijack discovery: NO match for ${callId} in ${pendingToolCalls.size} pending calls`);
            }
        }

        // 2.5 Concurrency Gating: Wait if there's already an active (unparked) turn for this conversation
        if (!hijackedTurnId) {
            let waitAttempts = 0;
            const MAX_WAIT_ATTEMPTS = 60; // 30 seconds max
            while (activeTurnsByHash.has(historyHash)) {
                const existingTurnId = activeTurnsByHash.get(historyHash);
                if (process.env.GEMINI_DEBUG_HANDOFF === 'true') {
                    console.log(`[Queue] Conversation ${historyHash} already has active turn ${existingTurnId}. Waiting... (${waitAttempts})`);
                }

                // If it parks while we are waiting, we can hijack it!
                for (const [callKey, pending] of pendingToolCalls.entries()) {
                    if (pending.turnId === existingTurnId) {
                        hijackedTurnId = existingTurnId;
                        console.log(`[API] Hijack discovery (WFI): Turn ${hijackedTurnId} parked while waiting. Hijacking!`);
                        break;
                    }
                }
                if (hijackedTurnId) break;

                await new Promise(r => setTimeout(r, 500));
                waitAttempts++;
                if (waitAttempts > MAX_WAIT_ATTEMPTS) {
                    console.warn(`[Queue] Timeout waiting for active turn ${existingTurnId}. Proceeding with new turn.`);
                    break;
                }
            }
        }

        // Preemption: Kill any old turns for the same conversation that aren't being hijacked right now
        for (const [pTurnId, parked] of parkedTurns.entries()) {
            if (parked.historyHash === historyHash && pTurnId !== hijackedTurnId) {
                console.log(`[API] Preemption: Killing old parked turn ${pTurnId} for same conversation thread.`);
                parked.controller.cancelCurrentTurn(pTurnId);
                // The Turn conclusion logic (finally block in executeTask) will cleanup parkedTurns and workspace
            }
        }

        const isStreaming = req.body.stream === true;
        let accumulatedText = '';
        let accumulatedToolCalls = [];
        let finalStats = null;
        let responseSent = false;

        if (isStreaming) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
        }
        req.setTimeout(0);
        res.setTimeout(0);

        const sendChunk = (chunk) => {
            if (isStreaming && !res.writableEnded) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
        };

        const heartbeatInterval = isStreaming ? setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
        }, 15000) : null;

        const responseModel = req.body.model || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

        const onText = (text) => {
            if (isStreaming) {
                sendChunk({
                    id: `chatcmpl-stream`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: responseModel,
                    choices: [{ index: 0, delta: { content: text } }]
                });
            } else {
                accumulatedText += text;
            }
        };

        const onToolCall = (info) => {
            console.log(`[Turn ${turnId}] Dispatching Tool Call: ${info.name} (${info.id})`);
            if (isStreaming) {
                sendChunk({
                    id: `chatcmpl-stream`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: responseModel,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: info.id,
                                type: 'function',
                                function: { name: info.name, arguments: info.arguments }
                            }]
                        },
                        finish_reason: 'tool_calls'
                    }]
                });
                if (!res.writableEnded) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    responseSent = true;
                }
            } else {
                accumulatedToolCalls.push({
                    id: info.id,
                    type: 'function',
                    function: { name: info.name, arguments: info.arguments }
                });
                // In non-streaming mode, we don't send the response yet.
                // We wait for the 'done' or 'result' event or process exit if we expect others.
                // However, the current CLI implementation often sends one tool use and parks.
                // If it hits a "done" or parks, onResult or the end of sendPrompt will trigger.
            }
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        const onError = (err) => {
            const errorObj = {
                message: typeof err === 'string' ? err : (err.message || "Unknown error"),
                type: "internal_error",
                code: "cli_failure"
            };

            if (isStreaming) {
                sendChunk({ error: errorObj });
                if (!res.writableEnded) res.end();
            } else {
                if (!res.headersSent) res.status(500).json({ error: errorObj });
            }
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        const onResult = (json) => {
            finalStats = json.stats || {};
            if (isStreaming) {
                sendChunk({
                    id: `chatcmpl-stream`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: responseModel,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: {
                        prompt_tokens: finalStats.input_tokens || 0,
                        completion_tokens: finalStats.output_tokens || 0,
                        total_tokens: finalStats.total_tokens || 0
                    }
                });
                if (!res.writableEnded) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    responseSent = true;
                }
            } else {
                if (!res.headersSent) {
                    res.json({
                        id: `chatcmpl-${randomUUID()}`,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: responseModel,
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: accumulatedText,
                                tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined
                            },
                            finish_reason: accumulatedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                        }],
                        usage: {
                            prompt_tokens: finalStats.input_tokens || 0,
                            completion_tokens: finalStats.output_tokens || 0,
                            total_tokens: finalStats.total_tokens || 0
                        }
                    });
                    responseSent = true;
                }
            }
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        // --- CONCURRENCY GATING ---
        // historyHash and hijackedTurnId are already declared at the top of the request handler.
        // We update/refine them here.
        if (!hijackedTurnId) {
            hijackedTurnId = activeTurnsByHash.get(historyHash);
        }

        // --- WAIT-AND-HIJACK CASE ---
        // If a turn is active but NOT yet parked, wait for it to park.
        if (hijackedTurnId && !parkedTurns.has(hijackedTurnId)) {
            console.log(`[API] Wait-and-Hijack: Turn ${hijackedTurnId} is running but not parked. Waiting...`);
            let waitStart = Date.now();
            while (hijackedTurnId && !parkedTurns.has(hijackedTurnId) && (Date.now() - waitStart < 30000)) {
                await new Promise(r => setTimeout(r, 500));
                // Re-check if it's still active (might have finished instead of parking)
                hijackedTurnId = activeTurnsByHash.get(historyHash);
            }
        }

        // --- HANDOFF CASE ---
        if (hijackedTurnId && parkedTurns.has(hijackedTurnId)) {
            const parked = parkedTurns.get(hijackedTurnId);
            const isToolContinuation = lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function');

            if (isToolContinuation) {
                console.log(`[API] Warm Handoff: Hijacking turn ${hijackedTurnId} for tool result resolution.`);
            } else {
                console.log(`[API] Warm Handoff: Hijacking turn ${hijackedTurnId} as Proxy (Retry).`);
            }

            // 1. Update callbacks to pipe output to THIS response
            controller.updateCallbacks(hijackedTurnId, { onText, onToolCall, onError, onResult });

            // 2. Resolve or Re-emit
            if (isToolContinuation) {
                const toolContent = lastMsg.content;
                const callId = lastMsg.tool_call_id;
                const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;
                let resolved = false;
                for (const [callKey] of pendingToolCalls.entries()) {
                    if (callKey.startsWith(shortKey)) {
                        resolveToolCall(callKey, toolContent);
                        resolved = true;
                        break;
                    }
                }

                if (!resolved) {
                    console.warn(`[API] Could not find pending tool call for ID ${callId}`);
                    // If we can't find the tool call, it might be a race. Fallback to wait.
                }
            } else {
                // Proxy Hijack: Re-emit the pending tool call to the NEW requester
                let reemitted = false;
                for (const [callKey, pending] of pendingToolCalls.entries()) {
                    if (pending.turnId === hijackedTurnId) {
                        const callId = `call_${callKey.substring(0, 8)}`;
                        console.log(`[API] Proxy Hijack: Re-emitting call ${callId} (${pending.name})`);
                        onToolCall({
                            id: callId,
                            name: pending.name,
                            arguments: pending.arguments
                        });
                        reemitted = true;
                        break;
                    }
                }
                if (!reemitted) {
                    console.warn(`[API] Proxy Hijack: No pending tool call found for Turn ${hijackedTurnId}. Falling back to wait.`);
                }
            }

            // 3. Await the conclusion of the TASK from the new request side
            await parked.executePromise;
            return;
        }


        // --- NEW TURN CASE ---
        const turnId = req.turnId || randomUUID();
        const turnTempDir = path.join(baseTempDir, turnId);
        if (!fs.existsSync(turnTempDir)) fs.mkdirSync(turnTempDir, { recursive: true });

        // Serialize history (Strict Stateless Narrator)
        let systemMessage = "";
        let conversationPromptSection = ""; // Renamed to avoid shadowed top-level historyHash if any
        let imageCounter = 0;

        // Check if the last message is a slash command (for probing)
        lastMsg = messages[messages.length - 1];
        const isSlash = lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.trim().startsWith('/');

        if (isSlash) {
            conversationPromptSection = lastMsg.content.trim();
        } else {
            for (const msg of req.body.messages) {
                if (msg.role === 'system') systemMessage += (msg.content || "") + "\n";
                else {
                    let text = msg.content;
                    if (Array.isArray(text)) {
                        text = text.map(p => {
                            if (p.type === 'text') return sanitizePromptText(p.text);
                            if (p.type === 'image_url') {
                                const b64 = p.image_url.url.split(',')[1];
                                const ext = p.image_url.url.split(';')[0].split('/')[1] || 'png';
                                const imgPath = path.join(turnTempDir, `image_${++imageCounter}.${ext}`);
                                fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
                                return `@${imgPath}`;
                            }
                            return '';
                        }).join('\n');
                    } else {
                        text = sanitizePromptText(text || "");
                    }

                    if (msg.role === 'user') conversationPromptSection += `USER: ${text}\n\n`;
                    else if (msg.role === 'assistant') {
                        let content = text;
                        if (msg.tool_calls) {
                            for (const tc of msg.tool_calls) {
                                const callId = tc.id || tc.tool_call_id || 'unknown';
                                content += `\n<action id="${callId}">Called tool '${tc.function?.name || tc.name}' with args: ${tc.function?.arguments || tc.arguments}</action>`;
                            }
                        }
                        conversationPromptSection += `ASSISTANT: ${content.trim()}\n\n`;
                    } else if (msg.role === 'tool' || msg.role === 'function') {
                        const callId = msg.tool_call_id || 'unknown';
                        conversationPromptSection += `<result id="${callId}">\n${text}\n</result>\n\n`;
                    }
                }
            }
        }

        console.log(`[API] turnId: ${turnId} - Prompt Stats: System=${systemMessage.length} chars, History=${conversationPromptSection.length} chars`);

        // Debug Persistence: Create directory if needed
        if (process.env.GEMINI_DEBUG_PROMPTS === 'true') {
            const debugDir = path.join(process.cwd(), 'debug_prompts');
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        }

        // Per-turn IPC: Use /tmp for Unix sockets to avoid host-mount incompatibilities (ENOTSUP)
        const ipcPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\ionosphere-${turnId}`
            : path.join('/tmp', `ionosphere-${turnId}.sock`);

        const ipcServer = net.createServer((socket) => {
            let buf = '';
            socket.on('data', (chunk) => {
                buf += chunk.toString();
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    try {
                        const msg = JSON.parse(line);
                        if (msg.event === 'tool_call') {
                            const callKey = randomUUID();
                            const callId = `call_${callKey.substring(0, 8)}`;
                            pendingToolCalls.set(callKey, {
                                socket,
                                turnId,
                                name: msg.name,
                                arguments: msg.arguments
                            });

                            // Ensure the turn is marked as PARKED if it wasn't already
                            if (!parkedTurns.has(turnId)) {
                                console.log(`[Turn ${turnId}] Parking via IPC tool call: ${msg.name}`);
                                parkedTurns.set(turnId, {
                                    controller,
                                    executePromise: globalPromiseMap.get(turnId), // Use a global map to find the promise
                                    cleanupWorkspace: () => fs.rmSync(turnTempDir, { recursive: true, force: true }),
                                    historyHash
                                });
                            }

                            // Trigger dispatcher (Handoff logic will pick this up when the CLIENT calls back)
                            controller.callbacksByTurn.get(turnId)?.onToolCall({
                                id: callId,
                                name: msg.name,
                                arguments: msg.arguments
                            });
                        }
                    } catch (e) {
                        console.error(`[IPC] Parse error on turn ${turnId}:`, e);
                    }
                }
            });
        });

        await new Promise((resolve) => {
            ipcServer.listen(ipcPath, () => resolve());
            ipcServer.on('error', (err) => {
                if (process.platform !== 'win32') {
                    try { if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath); } catch (_) { }
                }
                if (err.code === 'EADDRINUSE') {
                    console.warn(`[IPC] Address in use, retrying after cleanup: ${ipcPath}`);
                    ipcServer.listen(ipcPath, () => resolve());
                } else {
                    console.error(`[IPC] Server error: ${err.message}`);
                }
            });
        });

        // Config
        const settingsPath = path.join(turnTempDir, '.gemini', 'settings.json');
        const openAiTools = req.body.tools || null;
        let mcpServers = null;
        if (openAiTools || req.body.mcpServers) {
            const toolBridgeEnv = { TOOL_BRIDGE_IPC: ipcPath };
            if (openAiTools) {
                const toolsPath = path.join(turnTempDir, 'tools.json');
                fs.writeFileSync(toolsPath, JSON.stringify(openAiTools));
                toolBridgeEnv.TOOL_BRIDGE_TOOLS = toolsPath;
            }
            if (req.body.mcpServers) {
                const mcpPath = path.join(turnTempDir, 'mcp_servers.json');
                fs.writeFileSync(mcpPath, JSON.stringify(req.body.mcpServers));
                toolBridgeEnv.TOOL_BRIDGE_MCP_SERVERS = mcpPath;
            }
            mcpServers = { 'ionosphere-tool-bridge': { command: 'node', args: [TOOL_BRIDGE_PATH], env: toolBridgeEnv, trust: true } };
        }

        const onEvent = (json) => {
            console.log(`[Turn ${turnId}] CLI Event: ${json.type}`);
        };

        generateConfig({ targetPath: settingsPath, mcpServers, modelName: req.body.model });

        const executeTask = async () => {
            let taskResolve;
            const executePromise = new Promise(r => taskResolve = r);
            globalPromiseMap.set(turnId, executePromise);

            try {
                activeTurnsByHash.set(historyHash, turnId);
                await controller.sendPrompt(turnId, (conversationPromptSection || conversationPrompt).trim(), turnTempDir, settingsPath, systemMessage.trim(), {
                    onText, onToolCall, onError, onResult, onEvent
                }, {
                    IONOSPHERE_IPC: ipcPath,
                    IONOSPHERE_HISTORY_HASH: historyHash
                });

                // Final safety for non-streaming multi-tool or parked turns
                if (!isStreaming && !responseSent) {
                    if (accumulatedToolCalls.length > 0) {
                        onResult({ stats: {} }); // Force completion with gathered tools
                    }
                }
            } finally {
                console.log(`[Turn ${turnId}] Concluded. Active: ${currentlyRunning}/${MAX_CONCURRENT_CLI}, Parked: ${parkedTurns.size}`);
                if (activeTurnsByHash.get(historyHash) === turnId) {
                    activeTurnsByHash.delete(historyHash);
                }
                parkedTurns.delete(turnId);
                globalPromiseMap.delete(turnId);
                taskResolve();
                ipcServer.close();
                if (process.platform !== 'win32') {
                    try { if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath); } catch (_) { }
                }
                fs.rmSync(turnTempDir, { recursive: true, force: true });
            }
        };

        await enqueueControllerPrompt(executeTask);

    } catch (err) {
        console.error("[API Error]", err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.end();
    }
});

app.get('/v1/models', (req, res) => {
    const models = [
        { id: "auto-gemini-3", context_window: 1000000 },
        { id: "auto-gemini-2.5", context_window: 1000000 },
        { id: "gemini-3-pro-preview", context_window: 1000000 },
        { id: "gemini-3-flash-preview", context_window: 1000000 },
        { id: "gemini-2.5-pro", context_window: 1000000 },
        { id: "gemini-2.5-flash", context_window: 1000000 },
        { id: "gemini-2.5-flash-lite", context_window: 1000000 },
        { id: "gemini-2.0-flash", context_window: 1000000 }
    ];
    res.json({
        object: "list",
        data: models.map(m => ({
            id: m.id,
            object: "model",
            created: 1686935002,
            owned_by: "google",
            context_window: m.context_window
        }))
    });
});

app.get('/v1/models/:model', (req, res) => {
    const models = [
        { id: "auto-gemini-3", context_window: 1000000 },
        { id: "auto-gemini-2.5", context_window: 1000000 },
        { id: "gemini-3-pro-preview", context_window: 1000000 },
        { id: "gemini-3-flash-preview", context_window: 1000000 },
        { id: "gemini-2.5-pro", context_window: 1000000 },
        { id: "gemini-2.5-flash", context_window: 1000000 },
        { id: "gemini-2.5-flash-lite", context_window: 1000000 },
        { id: "gemini-2.0-flash", context_window: 1000000 }
    ];
    const modelId = req.params.model;
    const model = models.find(m => m.id === modelId);

    if (model) {
        return res.json({
            id: model.id,
            object: "model",
            created: 1686935002,
            owned_by: "google",
            context_window: model.context_window
        });
    }

    res.status(404).json({
        error: {
            message: `The model '${modelId}' does not exist`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found"
        }
    });
});

app.get('/health', (req, res) => res.json({ status: "ok" }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ionosphere Orchestrator listening on port ${PORT}`);
});
