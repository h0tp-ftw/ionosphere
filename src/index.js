import express from 'express';
import cors from 'cors';
import multer from 'multer';
import net from 'net';
import { GeminiController } from './GeminiController.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { generateConfig } from '../scripts/generate_settings.js';
import { formatErrorResponse, getStatusCode, createError, ErrorType, ErrorCode } from './errorHandler.js';
import { getHistoryHash, getConversationFingerprint, findHijackedTurnId } from './session_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the tool-bridge MCP server entry point
const TOOL_BRIDGE_PATH = path.resolve(__dirname, '..', 'packages', 'tool-bridge', 'index.js');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());


/**
 * Refines the JSON Schema to prevent Gemini CLI validation crashes
 * while maintaining structural integrity for the model.
 */
const loosenSchema = (obj) => {
    if (!obj || typeof obj !== 'object') return;

    // We no longer delete 'required' or 'type' fields.
    // Deleting them caused 'Validation Loops' in apps like Cline 
    // that strictly enforce mandatory parameters (e.g., requires_approval).

    // Deep Loosening: Remove format constraints to prevent CLI validation crashes.
    // This remains the primary cause of pre-flight schema errors.
    if (obj.format) {
        if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
            console.log(`[Schema] Loosening: Removing 'format: ${obj.format}' from field.`);
        }
        delete obj.format;
    }

    for (const key in obj) {
        if (typeof obj[key] === 'object') {
            loosenSchema(obj[key]);
        }
    }
};


// Ensure base temp directory exists
const baseTempDir = path.join(process.cwd(), 'temp');
if (!fs.existsSync(baseTempDir)) {
    fs.mkdirSync(baseTempDir, { recursive: true });
}

// Ensure persistent uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Files API Registry
const filesRegistryPath = path.join(process.cwd(), 'files.json');
const loadFilesRegistry = () => {
    if (!fs.existsSync(filesRegistryPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(filesRegistryPath, 'utf8'));
    } catch (e) {
        console.error(`[Files] Registry corrupt:`, e.message);
        return {};
    }
};
const saveFilesRegistry = (registry) => {
    fs.writeFileSync(filesRegistryPath, JSON.stringify(registry, null, 2));
};

// Setup multer for persistent uploads separately
const persistentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const fileId = 'file-' + randomUUID();
        // Store the ID in the file object so the route can use it
        file.fileId = fileId;
        const ext = path.extname(file.originalname);
        cb(null, fileId + ext);
    }
});
const persistentUpload = multer({ storage: persistentStorage });

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
const WARM_HANDOFF_ENABLED = process.env.WARM_HANDOFF_ENABLED !== 'false';
console.log(`[Config] Warm Handoff: ${WARM_HANDOFF_ENABLED ? 'ENABLED' : 'DISABLED'}`);

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
        if (process.env.GEMINI_DEBUG_IPC === 'true') {
            console.warn(`[IPC] resolveToolCall: No pending call for ${callKey}`);
        }
        return false;
    }
    pendingToolCalls.delete(callKey);
    try {
        // Robust Extraction: Detect and unwrap MCP/OpenAI-style content blocks
        let extractedResult = result;
        if (Array.isArray(result)) {
            // Extract text from the first text block if it looks like an array of content
            const textBlock = result.find(c => c.type === 'text');
            if (textBlock && typeof textBlock.text === 'string') {
                extractedResult = textBlock.text;
            } else if (result.length > 0) {
                // Fallback: use first element if it's a string, or stringify it correctly
                extractedResult = typeof result[0] === 'string' ? result[0] : JSON.stringify(result[0]);
            }
        } else if (result && typeof result === 'object' && result.content) {
            // Handle { content: [...] } wrapper
            return resolveToolCall(callKey, result.content);
        }

        let resultStr = typeof extractedResult === 'string' ? extractedResult : JSON.stringify(extractedResult, null, 2);

        // Ensure we never send an empty or undefined result to the CLI, which causes "result missing"
        if (!resultStr || resultStr.trim() === "") {
            console.warn(`[IPC] Warning: Tool ${pending.name} returned empty result. Normalizing.`);
            resultStr = "Success: (Empty result)";
        }

        console.log(`[IPC] Sending result to turn ${pending.turnId} for tool ${callKey}`);
        if (process.env.GEMINI_DEBUG_IPC === 'true') {
            const snippet = resultStr.length > 500 ? resultStr.substring(0, 500) + '...' : resultStr;
            console.log(`[IPC] Result length: ${resultStr.length}, Snippet: ${JSON.stringify(snippet)}`);
        }

        pending.socket.write(JSON.stringify({ event: 'tool_result', result: resultStr }) + '\n');
        pending.socket.end();
        console.log(`[IPC] Resolved tool call ${callKey} (Turn: ${pending.turnId})`);
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

// --- FILES API ---

app.post('/v1/files', persistentUpload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: { message: "No file provided", type: "invalid_request_error" } });
    }

    const registry = loadFilesRegistry();
    const fileMetadata = {
        id: req.file.fileId,
        object: "file",
        bytes: req.file.size,
        created_at: Math.floor(Date.now() / 1000),
        filename: req.file.originalname,
        purpose: req.body.purpose || "assistants",
        status: "processed",
        path: req.file.path // local internal path
    };

    registry[fileMetadata.id] = fileMetadata;
    saveFilesRegistry(registry);

    res.json(fileMetadata);
});

app.get('/v1/files', (req, res) => {
    const registry = loadFilesRegistry();
    const files = Object.values(registry).map(({ path, ...meta }) => meta);
    res.json({ object: "list", data: files });
});

app.get('/v1/files/:file_id', (req, res) => {
    const registry = loadFilesRegistry();
    const meta = registry[req.params.file_id];
    if (!meta) return res.status(404).json({ error: { message: "File not found", type: "invalid_request_error" } });
    const { path: _, ...publicMeta } = meta;
    res.json(publicMeta);
});

app.delete('/v1/files/:file_id', (req, res) => {
    const registry = loadFilesRegistry();
    const meta = registry[req.params.file_id];
    if (meta) {
        if (fs.existsSync(meta.path)) {
            fs.unlinkSync(meta.path);
        }
        delete registry[req.params.file_id];
        saveFilesRegistry(registry);
        return res.json({ id: req.params.file_id, object: "file", deleted: true });
    }
    res.status(404).json({ error: { message: "File not found", type: "invalid_request_error" } });
});

app.post('/v1/chat/completions', handleUpload, async (req, res) => {
    try {
        // 1. Authorization
        const expectedApiKey = process.env.API_KEY;
        if (expectedApiKey) {
            const authHeader = req.headers['authorization'];
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                console.log("[API] Auth Failed: Missing header");
                const err = createError("Missing or formatted improperly Authorization header.", ErrorType.AUTHENTICATION, ErrorCode.INVALID_API_KEY);
                return res.status(401).json({ error: err });
            }
            if (authHeader.substring(7) !== expectedApiKey) {
                console.log("[API] Auth Failed: Invalid key");
                const err = createError("Invalid API Key", ErrorType.AUTHENTICATION, ErrorCode.INVALID_API_KEY);
                return res.status(401).json({ error: err });
            }
        }

        // If multipart, some fields might be JSON-encoded strings
        if (req.is('multipart/form-data')) {
            if (typeof req.body.messages === 'string') {
                try { req.body.messages = JSON.parse(req.body.messages); } catch (e) { }
            }
            if (typeof req.body.tools === 'string') {
                try { req.body.tools = JSON.parse(req.body.tools); } catch (e) { }
            }
            if (typeof req.body.mcpServers === 'string') {
                try { req.body.mcpServers = JSON.parse(req.body.mcpServers); } catch (e) { }
            }
        }

        let messages = req.body.messages;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: createError("Missing 'messages' array", ErrorType.INVALID_REQUEST, 'invalid_parameter') });
        }

        // logRequestForensics(req);

        if (process.env.GEMINI_DEBUG_MESSAGES === 'true') {
            console.log(`[FORENSICS] Full Messages Array:\n${JSON.stringify(messages, null, 2)}`);
        }

        const historyHash = getHistoryHash(messages);
        const fingerprint = getConversationFingerprint(messages);

        const historicalTools = [];
        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    let toolName = tc.function?.name || tc.name;
                    // Uniform Namespacing: We no longer force prefixes.
                    // The Selective Blindness patch handles collision safety.
                    const rawArgs = tc.function?.arguments || tc.arguments || "{}";
                    const toolArgs = JSON.stringify(typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs);
                    historicalTools.push(`${historyHash}:${toolName}:${toolArgs}`);
                }
            }
        }

        // --- TURN IDENTITY ---
        // We define activeTurnId early so it's available for all closures and hijacking logic.
        const activeTurnId = req.turnId || randomUUID();

        const conversationPrompt = messages.map(m => {
            if (m.role === 'user') return `USER: ${m.content}`;
            if (m.role === 'assistant') return `ASSISTANT: ${m.content}`;
            if (m.role === 'tool') return `[TOOL RESULT]: ${m.content}`;
            return `${m.role.toUpperCase()}: ${m.content}`;
        }).join('\n\n');

        // 2. Identify "Handoff" (Warm Stateless Continuity)
        let lastMsg = messages[messages.length - 1];

        // Find existing session to hijack using robust logic (Deep Scan + Fingerprint)
        let { turnId: hijackedTurnId, matchType } = findHijackedTurnId(messages, historyHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls, process.env.GEMINI_DEBUG_HANDOFF === "true") || {};

        if (hijackedTurnId === activeTurnId) {
            console.log(`[API] Self-collision detected for turn ${activeTurnId}. Clearing stale mapping.`);
            activeTurnsByHash.delete(fingerprint);
            activeTurnsByHash.delete(historyHash);
            hijackedTurnId = null;
        }


        // Handle "New Instruction" Case (Preemption)
        if (hijackedTurnId) {
            const isToolMatch = matchType === 'tool_call';
            const isHashMatch = activeTurnsByHash.get(historyHash) === hijackedTurnId;

            // Preemption Rule: If the hash changed (new messages) and the last message is from a USER,
            // we should consider if this is a new instruction that should kill the old turn.
            if (lastMsg && lastMsg.role === 'user' && !isHashMatch) {
                let shouldPreempt = false;

                if (isToolMatch) {
                    // Even if we have a tool match, we preempt if the USER message DOES NOT look like a tool narration.
                    // This allows users to "break out" of a tool wait (e.g. Weather -> "Wait, cancel that, say POP").
                    let contentStr = "";
                    if (typeof lastMsg.content === 'string') contentStr = lastMsg.content;
                    else if (Array.isArray(lastMsg.content)) contentStr = lastMsg.content.map(p => p.text || p.content || "").join("");

                    const isNarration = contentStr.includes('] Result:') || contentStr.match(/\[.*?\]\s*Result:/i);
                    if (process.env.GEMINI_DEBUG_HANDOFF === 'true') {
                        console.log(`[API] Preemption Check: isToolMatch=${isToolMatch}, isNarration=${isNarration}, contentStr="${contentStr.substring(0, 50)}..."`);
                    }
                    if (!isNarration) {
                        console.log(`[API] One Session Rule: User provided new instruction while turn ${hijackedTurnId} was waiting for a tool. Preempting.`);
                        shouldPreempt = true;
                    }
                } else {
                    // Regular fingerprint match with no tool continuation: always preempt on new USER instruction
                    console.log(`[API] One Session Rule: Preempting old turn ${hijackedTurnId} for new instruction on fingerprint ${fingerprint}`);
                    shouldPreempt = true;
                }

                if (shouldPreempt) {
                    controller.cancelCurrentTurn(hijackedTurnId);
                    parkedTurns.delete(hijackedTurnId);
                    activeTurnsByHash.delete(fingerprint);
                    activeTurnsByHash.delete(historyHash);
                    // Clean up any pending tool calls for the preempted turn
                    for (const [callKey, pending] of pendingToolCalls.entries()) {

                        if (pending.turnId === hijackedTurnId) {
                            pendingToolCalls.delete(callKey);
                        }
                    }
                    await new Promise(r => setTimeout(r, 200));
                    hijackedTurnId = null; // Proceed to NEW TURN
                }
            }
        }

        // 2.5 Concurrency Gating: Final safety to ensure no two turns for the same fingerprint run simultaneously
        if (!hijackedTurnId) {
            const existingTurnId = activeTurnsByHash.get(fingerprint) || activeTurnsByHash.get(historyHash);
            if (existingTurnId) {
                console.log(`[API] One Session Rule: Killing orphaned/stale active turn ${existingTurnId} before starting new turn.`);
                controller.cancelCurrentTurn(existingTurnId);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Preemption: Kill any old turns for the same conversation that aren't being hijacked right now
        for (const [pTurnId, parked] of parkedTurns.entries()) {
            if (parked.historyHash === historyHash && pTurnId !== hijackedTurnId) {
                console.log(`[API] Preemption: Killing old parked turn ${pTurnId} for same conversation thread.`);
                parked.controller.cancelCurrentTurn(pTurnId);
                // Force immediate cleanup if cancellation doesn't trigger finally block fast enough
                parkedTurns.delete(pTurnId);
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

        // Handle client disconnect mid-turn
        let disconnectTimeout = null;
        res.on('close', () => {
            if (!responseSent) {
                if (isStreaming) {
                    console.log(`[Turn ${activeTurnId}] Client disconnected (Streaming). Terminating turn.`);
                    controller.cancelCurrentTurn(activeTurnId);
                    responseSent = true;
                } else {
                    const graceMs = parseInt(process.env.DISCONNECT_GRACE_PERIOD_MS) || 5000;
                    console.log(`[Turn ${activeTurnId}] Client disconnected (Non-streaming). Waiting ${graceMs}ms grace period before termination...`);
                    disconnectTimeout = setTimeout(() => {
                        if (!responseSent) {
                            console.log(`[Turn ${activeTurnId}] Grace period expired for Turn ${activeTurnId}. Terminating.`);
                            controller.cancelCurrentTurn(activeTurnId);
                            responseSent = true;
                        }
                    }, graceMs);
                }
            }
        });

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
            if (responseSent || res.writableEnded) {
                if (process.env.GEMINI_DEBUG_HANDOFF === 'true') console.log(`[Turn ${activeTurnId}] Suppressing onText: responseSent=${responseSent}, writableEnded=${res.writableEnded}`);
                return;
            }
            const contextMsg = hijackedTurnId ? `[HIJACKED from ${hijackedTurnId}] ` : "";
            if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                console.log(`[Turn ${activeTurnId}] ${contextMsg}SSE Text Chunk: ${text.substring(0, 50)}...`);
            }
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
            if (responseSent || res.writableEnded) {
                if (process.env.GEMINI_DEBUG_HANDOFF === 'true') console.log(`[Turn ${activeTurnId}] Suppressing onToolCall: responseSent=${responseSent}, writableEnded=${res.writableEnded}`);
                return;
            }
            // Force stringification of arguments for strict OpenAI compatibility
            const argsStr = typeof info.arguments === 'string' ? info.arguments : JSON.stringify(info.arguments || {});

            console.log(`[Turn ${activeTurnId}] Dispatching Tool Call: ${info.name} (${info.id}) FULL ARGS: ${argsStr}`);

            const toolCall = {
                id: info.id,
                type: 'function',
                function: { name: info.name, arguments: argsStr }
            };

            accumulatedToolCalls.push(toolCall);

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
                                ...toolCall,
                                index: accumulatedToolCalls.length - 1
                            }]
                        }
                    }]
                });
            }
        };

        const onError = (err) => {
            if (responseSent || res.writableEnded) {
                if (process.env.GEMINI_DEBUG_HANDOFF === 'true') console.log(`[Turn ${activeTurnId}] Suppressing onError: responseSent=${responseSent}, writableEnded=${res.writableEnded}`);
                return;
            }
            if (disconnectTimeout) clearTimeout(disconnectTimeout);
            responseSent = true;

            const errorObj = formatErrorResponse(err);
            const status = getStatusCode(errorObj);

            if (isStreaming) {
                sendChunk({ error: errorObj });
                if (!res.writableEnded) res.end();
            } else {
                if (!res.headersSent) res.status(status).json({ error: errorObj });
            }
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        const onResult = (json) => {
            if (responseSent || res.writableEnded) {
                if (process.env.GEMINI_DEBUG_HANDOFF === 'true') console.log(`[Turn ${activeTurnId}] Suppressing onResult: responseSent=${responseSent}, writableEnded=${res.writableEnded}`);
                return;
            }
            if (disconnectTimeout) clearTimeout(disconnectTimeout);
            responseSent = true;
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
                        total_tokens: (finalStats.input_tokens || 0) + (finalStats.output_tokens || 0)
                    }
                });
                if (!res.writableEnded) {
                    res.write('data: [DONE]\n\n');
                    res.end();
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
                            total_tokens: (finalStats.input_tokens || 0) + (finalStats.output_tokens || 0)
                        }
                    });
                }
            }
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        const onEvent = (json) => {
            if (process.env.GEMINI_DEBUG_RAW === 'true') {
                console.log(`[Turn ${activeTurnId}] CLI Event: ${json.type}`);
            }
        };

        const onPark = (msg) => {
            if (responseSent || res.writableEnded) {
                if (process.env.GEMINI_DEBUG_HANDOFF === 'true') console.log(`[Turn ${activeTurnId}] Suppressing onPark: responseSent=${responseSent}, writableEnded=${res.writableEnded}`);
                return;
            }
            if (disconnectTimeout) clearTimeout(disconnectTimeout);
            responseSent = true; // Mark BEFORE sending to ensure no close-race
            console.log(`[Turn ${activeTurnId}] Yielding response on Parked state. Tool: ${msg.name}`);

            if (isStreaming) {
                // Send finish_reason if we have tool calls
                sendChunk({
                    id: `chatcmpl-stream`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: responseModel,
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: accumulatedToolCalls.length > 0 ? "tool_calls" : "stop"
                    }]
                });
                if (!res.writableEnded) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            } else {
                const payload = {
                    id: `chatcmpl-${activeTurnId}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: responseModel,
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant",
                            content: accumulatedText,
                            tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined
                        },
                        finish_reason: accumulatedToolCalls.length > 0 ? "tool_calls" : "stop"
                    }],
                    usage: {
                        prompt_tokens: finalStats?.input_tokens || 0,
                        completion_tokens: finalStats?.output_tokens || 0,
                        total_tokens: (finalStats?.input_tokens || 0) + (finalStats?.output_tokens || 0)
                    }
                };
                res.json(payload);
            }
            responseSent = true;
            if (heartbeatInterval) clearInterval(heartbeatInterval);

            // In Warm Stateless Handoff, we keep the CLI parked and alive.
            // It will be resolved by the next HTTP request (the tool result),
            // or cleaned up by the GC/finally block if abandoned.
            if (!WARM_HANDOFF_ENABLED) {
                console.log(`[Turn ${activeTurnId}] Cold Handoff: Terminating process after yielding response.`);
                controller.cancelCurrentTurn(activeTurnId);
            }
        };

        // (Concurrency Gating consolidated into section 2/2.5)

        // --- WAIT-AND-HIJACK CASE ---
        // If a turn is active but NOT yet parked, wait for it to park.
        if (hijackedTurnId && !parkedTurns.has(hijackedTurnId)) {
            console.log(`[API] Wait-and-Hijack: Turn ${hijackedTurnId} is running. Polling for parking...`);
            let waitStart = Date.now();
            while (hijackedTurnId && !parkedTurns.has(hijackedTurnId) && (Date.now() - waitStart < 30000)) {
                await new Promise(r => setTimeout(r, 500));
                // If it parks while we wait, we are good to go
                if (parkedTurns.has(hijackedTurnId)) {
                    console.log(`[HIJACK] Wait-and-Hijack: Turn ${hijackedTurnId} parked! Proceeding to Handoff.`);
                    break;
                }
                // Refresh our view of who is active for this thread
                // Note: We use the robust finder to ensure we track the right session even if hash shifts
                const updated = findHijackedTurnId(messages, historyHash, fingerprint, activeTurnsByHash, parkedTurns, pendingToolCalls);
                if (updated && updated.turnId) hijackedTurnId = updated.turnId;
            }
            if (hijackedTurnId && !parkedTurns.has(hijackedTurnId)) {
                console.warn(`[API] Wait-and-Hijack: Timed out waiting for turn ${hijackedTurnId} to park. Falling back to fresh turn.`);
                hijackedTurnId = null;
            }
        }

        const allCallbacks = { onText, onToolCall, onError, onResult, onEvent, onPark, hijackedFrom: hijackedTurnId };

        // --- HANDOFF CASE ---
        if (hijackedTurnId && parkedTurns.has(hijackedTurnId)) {
            const parked = parkedTurns.get(hijackedTurnId);
            const proc = controller.processes.get(hijackedTurnId);

            if (!proc || proc.killed) {
                console.log(`[API] Handoff failed: Turn ${hijackedTurnId} is no longer active. Falling back to fresh turn.`);
                parkedTurns.delete(hijackedTurnId);
                hijackedTurnId = null;
                // Fall through to NEW TURN CASE
            } else {
                const isToolContinuation = lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function');

                if (isToolContinuation) {
                    console.log(`[API] Warm Handoff: Hijacking turn ${hijackedTurnId} for tool result resolution.`);
                } else {
                    // Defense-in-depth: If last message is a new user instruction (not a retry),
                    // do NOT re-emit the old tool call. Cancel and start fresh.
                    if (lastMsg && lastMsg.role === 'user') {
                        let contentStr = "";
                        if (typeof lastMsg.content === 'string') contentStr = lastMsg.content;
                        else if (Array.isArray(lastMsg.content)) contentStr = lastMsg.content.map(p => p.text || p.content || "").join("");

                        const isNarration = contentStr.includes('] Result:') || contentStr.match(/\[.*?\]\s*Result:/i);

                        if (!isNarration) {
                            console.log(`[API] Handoff Guard: New user instruction detected on parked turn ${hijackedTurnId}. Preempting.`);
                            controller.cancelCurrentTurn(hijackedTurnId);
                            parkedTurns.delete(hijackedTurnId);
                            for (const [callKey, pending] of pendingToolCalls.entries()) {
                                if (pending.turnId === hijackedTurnId) {
                                    pendingToolCalls.delete(callKey);
                                }
                            }
                            hijackedTurnId = null;
                            // Fall through to NEW TURN CASE
                        } else {
                            console.log(`[API] Warm Handoff: Hijacking turn ${hijackedTurnId} as Proxy (Narration).`);
                        }
                    } else {
                        console.log(`[API] Warm Handoff: Hijacking turn ${hijackedTurnId} as Proxy (Retry).`);
                    }
                }

                // Only proceed with handoff resolution if hijackedTurnId is still valid
                // (defense-in-depth guard above may have nullified it for new user instructions)
                if (hijackedTurnId) {
                    // 1. Update callbacks and sync historical context to the running process
                    const extraEnv = {
                        IONOSPHERE_HISTORY_HASH: historyHash,
                        IONOSPHERE_HISTORY_TOOLS: historicalTools.join(',')
                    };
                    controller.updateCallbacks(hijackedTurnId, allCallbacks, extraEnv);

                    // 2. Resolve or Re-emit
                    // Deep-scan: Check the last 10 messages for tool results.
                    // We scan BACKWARDS to find the most recent/relevant results first.
                    let resolvedAny = false;

                    // Race Condition Mitigation: wait a moment for the re-emission to arrive over IPC
                    // if history indicates we have results to deliver.
                    const scanRange = messages.slice(-10);
                    const hasUnresolvedResult = scanRange.some(m => (m.role === 'tool' || m.role === 'function' ||
                        (m.role === 'user' && (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes('] Result:'))));

                    if (hasUnresolvedResult && pendingToolCalls.size === 0) {
                        if (process.env.GEMINI_DEBUG_HANDOFF === 'true') console.log(`[API] Handoff: History has results but no pending tools. Waiting 300ms for re-emission...`);
                        await new Promise(r => setTimeout(r, 300));
                    }

                    if (process.env.GEMINI_DEBUG_HANDOFF === 'true') {
                        console.log(`[FORENSICS] Handoff scanRange (last 10): ${JSON.stringify(scanRange.map(m => ({ role: m.role, tool_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content.substring(0, 50) : 'obj' })), null, 2)}`);
                        console.log(`[FORENSICS] Pending tools for turn ${hijackedTurnId}: ${Array.from(pendingToolCalls.keys()).filter(k => pendingToolCalls.get(k).turnId === hijackedTurnId)}`);
                    }

                    // First pass: look for AUTHENTIC tool results
                    for (let i = scanRange.length - 1; i >= 0; i--) {
                        const msg = scanRange[i];
                        if (msg.role === 'tool' || msg.role === 'function') {
                            const callId = msg.tool_call_id;
                            const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;

                            let resultData = msg.content;
                            if (Array.isArray(resultData)) {
                                resultData = resultData.map(p => (typeof p === 'object' && p.type === 'text') ? p.text : "").join("");
                            }
                            const isGarbage = (typeof resultData === 'string' && (resultData.trim().toLowerCase() === "result missing" || resultData.trim() === ""));

                            if (shortKey) {
                                for (const [callKey, pending] of pendingToolCalls.entries()) {
                                    if (callKey.startsWith(shortKey)) {
                                        if (isGarbage) {
                                            // If this is garbage, see if the NEXT message is a USER narration of this tool result
                                            const nextMsg = scanRange[i + 1];
                                            if (nextMsg && nextMsg.role === 'user') {
                                                let nextContent = "";
                                                if (typeof nextMsg.content === 'string') {
                                                    nextContent = nextMsg.content;
                                                } else if (Array.isArray(nextMsg.content)) {
                                                    nextContent = nextMsg.content.map(p => (typeof p === 'object' && p.type === 'text') ? p.text : "").join("");
                                                }

                                                if (nextContent) {
                                                    // Pattern match for narrated result: [tool_name ...] Result: \n ...
                                                    const toolNameClean = pending.name.startsWith('ionosphere__') ? pending.name.substring(12) : pending.name;
                                                    const narrationPattern = new RegExp(`\\[${toolNameClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?\\]\\s*Result:\\s*\\n?([\\s\\S]*)`, 'i');
                                                    const match = nextContent.match(narrationPattern);
                                                    if (match && match[1]) {
                                                        console.log(`[API] Deep-scan match (Narrated): Extracted result for ${callId} from USER narration.`);
                                                        resultData = match[1].trim();
                                                    }
                                                }
                                            }
                                        }

                                        // If we still have garbage and there might be other results, keep looking
                                        if (typeof resultData === 'string' && resultData.trim().toLowerCase() === "result missing" && i > 0) {
                                            continue;
                                        }

                                        console.log(`[API] Deep-scan match: Resolving ${callId} (Tool: ${pending.name}) for turn ${hijackedTurnId}`);
                                        if (process.env.GEMINI_DEBUG_HANDOFF === 'true') {
                                            console.log(`[FORENSICS] Resolving with content (Full): ${JSON.stringify(resultData)}`);
                                        }
                                        resolveToolCall(callKey, resultData);
                                        resolvedAny = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (resolvedAny) break;
                    }

                    if (!resolvedAny) {
                        // If no results found in messages, it might be a Proxy Hijack (Retry)
                        // Re-emit the pending tool call so the client knows we are still waiting
                        let reemitted = false;
                        for (const [callKey, pending] of pendingToolCalls.entries()) {
                            if (pending.turnId === hijackedTurnId) {
                                const callId = `call_${callKey.substring(0, 8)}`;
                                const clientToolName = pending.clientName || (pending.name.startsWith('ionosphere__') ? pending.name.substring(12) : pending.name);

                                // Forensics: Log the arguments we are re-emitting
                                const argsLog = typeof pending.arguments === 'string' ? pending.arguments : JSON.stringify(pending.arguments);
                                console.log(`[API] Proxy Hijack: Re-emitting call ${callId} for tool '${clientToolName}' (Internal: ${pending.name}) FULL ARGS: ${argsLog}`);

                                onToolCall({
                                    id: callId,
                                    name: clientToolName,
                                    arguments: pending.arguments
                                });

                                // End the request since we are just re-emitting a parked state
                                onPark({ id: callId, name: clientToolName, arguments: pending.arguments });
                                reemitted = true;
                                break;
                            }
                        }
                        if (!reemitted) {
                            console.warn(`[API] Proxy Hijack: No pending tool call found for Turn ${hijackedTurnId}. Falling back.`);
                            hijackedTurnId = null;
                            // Fall through to NEW TURN CASE
                        } else {
                            return; // Request handled by re-emit
                        }
                    } else {
                        // 3. Await the conclusion of the TASK from the new request side
                        await parked.executePromise;
                        return;
                    }
                }
            }
        }


        // --- NEW TURN CASE ---
        const turnTempDir = path.join(baseTempDir, activeTurnId);
        if (!fs.existsSync(turnTempDir)) fs.mkdirSync(turnTempDir, { recursive: true });

        // Serialize history (Strict Stateless Narrator)
        let attachmentCounter = 0;
        let attachments = [];
        let systemMessage = "";
        let conversationPromptSection = "";
        // Find the LAST user message to identify which one needs environment details
        const userMessages = req.body.messages.filter(m => m.role === 'user');
        const lastUserMsg = userMessages[userMessages.length - 1];

        // Check if the last message is a slash command (for probing)
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
                            if (p.type === 'text') return p.text;

                            // OpenAI Multimodal support: image_url or file_url (often used for PDFs)
                            const urlObj = p.image_url || p.file_url;
                            if (urlObj) {
                                if (urlObj.url) {
                                    const url = urlObj.url;
                                    if (url.startsWith('data:')) {
                                        // Extract data and mime type: data:mime/type;base64,data
                                        const match = url.match(/^data:([^;]+);base64,(.+)$/);
                                        if (match) {
                                            const mime = match[1];
                                            const b64 = match[2];

                                            // Map mime types to common extensions
                                            let ext = 'bin';
                                            if (mime.includes('image/')) ext = mime.split('/')[1] || 'png';
                                            else if (mime === 'application/pdf') ext = 'pdf';
                                            else if (mime.includes('text/')) ext = 'txt';

                                            const filename = `attachment_${++attachmentCounter}.${ext}`;
                                            const imgPath = path.join(turnTempDir, filename);
                                            fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
                                            attachments.push(imgPath);
                                            return "";
                                        }
                                    } else {
                                        // Treat as a raw string if it's a URL
                                        return `[Attached URL: ${url}]`;
                                    }
                                }

                                // Resolve by file_id if present (OpenAI Files API integration)
                                const fileId = urlObj.id || urlObj.file_id || (p.type === 'file' ? (p.file?.id || p.file_id) : (p.type === 'input_file' ? p.file_id : null));
                                if (fileId) {
                                    const registry = loadFilesRegistry();
                                    const meta = registry[fileId];
                                    if (meta && fs.existsSync(meta.path)) {
                                        attachments.push(meta.path);
                                        return "";
                                    }
                                }
                            }

                            // Support for 'input_file' type directly
                            if (p.type === 'input_file' && p.file_id) {
                                const registry = loadFilesRegistry();
                                const meta = registry[p.file_id];
                                if (meta && fs.existsSync(meta.path)) {
                                    attachments.push(meta.path);
                                    return "";
                                }
                            }
                            return '';
                        }).join('\n');
                    } else {
                        text = text || "";
                    }

                    if (msg.role === 'user') {
                        // History Deduplication: Prevent prompt bloat in older messages
                        if (msg !== lastUserMsg) {
                            conversationPromptSection += `USER: ${text}\n\n`;
                        } else {
                            // Highlight the latest instruction specifically to help with context drift in large prompts
                            conversationPromptSection += `\n[LATEST INSTRUCTION]\nUSER: ${text}\n\n`;
                        }
                    }
                    else if (msg.role === 'assistant') {
                        let content = text;
                        if (msg.tool_calls) {
                            for (const tc of msg.tool_calls) {
                                const callId = tc.id || tc.tool_call_id || 'unknown';
                                let toolName = tc.function?.name || tc.name || 'unknown';

                                // Consistency Normalization: History now uses natural names.
                                // Collisions are prevented by the hardened CLI environment.

                                const argsStr = typeof (tc.function?.arguments || tc.arguments) === 'string'
                                    ? (tc.function?.arguments || tc.arguments)
                                    : JSON.stringify(tc.function?.arguments || tc.arguments || {});

                                content += `\n[Action (id: ${callId}): Called tool '${toolName}' with args: ${argsStr}]`;
                            }
                        }
                        conversationPromptSection += `ASSISTANT: ${content.trim()}\n\n`;
                    } else if (msg.role === 'tool' || msg.role === 'function') {
                        const callId = msg.tool_call_id || 'unknown';
                        const resultStr = typeof text === 'string' ? text : JSON.stringify(text);
                        conversationPromptSection += `[Tool Result (id: ${callId})]:\n${resultStr}\n\n`;
                    }
                }
            }
        }

        // Collect multimodal attachments (multipart uploads)
        if (req.files && Array.isArray(req.files)) {
            for (const file of req.files) {
                attachments.push(file.path);
            }
        }

        // Prime the assistant for a fresh turn if not a continuation or slash command
        if (!isSlash) {
            conversationPromptSection += "ASSISTANT: ";
        }


        // Debug Persistence: Create directory if needed
        // Debug Persistence: Create directory if needed
        if (process.env.GEMINI_DEBUG_PROMPTS !== 'false') {
            const debugDir = path.join(process.cwd(), 'debug_prompts');
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        }

        // Per-turn IPC: Use /tmp for Unix sockets to avoid host-mount incompatibilities (ENOTSUP)
        const ipcPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\ionosphere-${activeTurnId}`
            : path.join('/tmp', `ionosphere-${activeTurnId}.sock`);

        const ipcServer = net.createServer((socket) => {
            if (process.env.GEMINI_DEBUG_IPC === 'true') {
                console.log(`[IPC] Client connected for Turn ${activeTurnId}`);
            }
            let buf = '';
            socket.on('data', (chunk) => {
                buf += chunk.toString();
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (process.env.GEMINI_DEBUG_IPC === 'true') {
                        console.log(`[IPC] Raw payload: ${line}`);
                    }
                    try {
                        const msg = JSON.parse(line);
                        if (msg.event === 'tool_call') {
                            const callKey = randomUUID();
                            const callId = `call_${callKey.substring(0, 8)}`;

                            // Prefix stripping: send ORIGINAL names back to the client
                            const clientToolName = msg.name.startsWith('ionosphere__') ? msg.name.substring(12) : msg.name;

                            const argsStr = typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments || {});

                            pendingToolCalls.set(callKey, {
                                socket,
                                turnId: activeTurnId,
                                name: msg.name, // Internal namespaced name
                                clientName: clientToolName, // Stripped name for client compatibility
                                arguments: argsStr
                            });

                            // Ensure the turn is marked as PARKED if it wasn't already
                            if (!parkedTurns.has(activeTurnId)) {
                                console.log(`[Turn ${activeTurnId}] Parking via IPC tool call: ${msg.name}`);
                                parkedTurns.set(activeTurnId, {
                                    controller,
                                    executePromise: globalPromiseMap.get(activeTurnId),
                                    cleanupWorkspace: () => fs.rmSync(turnTempDir, { recursive: true, force: true }),
                                    historyHash
                                });
                            } else if (!WARM_HANDOFF_ENABLED) {
                                console.log(`[Turn ${activeTurnId}] Cold Handoff: Skipping parking for tool call ${msg.name}`);
                            }

                            // Trigger dispatcher
                            const callbacks = controller.callbacksByTurn.get(activeTurnId);
                            if (callbacks) {
                                callbacks.onToolCall({
                                    id: callId,
                                    name: clientToolName,
                                    arguments: argsStr
                                });
                                if (callbacks.onPark) {
                                    callbacks.onPark({ id: callId, name: clientToolName, arguments: msg.arguments });
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`[IPC] Parse error on turn ${activeTurnId}:`, e);
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

        // Write raw request JSON for offline forensics
        if (process.env.GEMINI_DEBUG_PROMPTS !== 'false') {
            fs.writeFileSync(path.join(turnTempDir, 'request.json'), JSON.stringify(req.body, null, 2));
            fs.writeFileSync(path.join(turnTempDir, 'serialized_prompt.txt'), (conversationPromptSection || conversationPrompt).trim());
        }

        // Config
        const settingsPath = path.join(turnTempDir, '.gemini', 'settings.json');
        const openAiTools = req.body.tools || null;
        let mcpServers = null;
        if (openAiTools || req.body.mcpServers) {
            const toolBridgeEnv = {
                TOOL_BRIDGE_IPC: ipcPath,
                GEMINI_DEBUG_TOOLS: process.env.GEMINI_DEBUG_TOOLS || 'false',
                GEMINI_DEBUG_IPC: process.env.GEMINI_DEBUG_IPC || 'false'
            };
            if (openAiTools) {
                const toolsPath = path.join(turnTempDir, 'tools.json');
                // Universal Tool Support: We no longer prefix with 'ionosphere__' 
                // as Phase 2 hardening deactivates native tool collisions in the CLI.
                const namespacedTools = [];
                for (const t of openAiTools) {
                    const originalName = t.function?.name || t.name;

                    // Always deep-copy to avoid side-effects on the original req.body.tools
                    const toolCopy = JSON.parse(JSON.stringify(t));
                    const fn = toolCopy.function || toolCopy;

                    // ALWAYS disable 'strict' mode for all tools to prevent validation hallucinations
                    toolCopy.strict = false;
                    if (fn.strict !== undefined) fn.strict = false;

                    // Generic Schema Relaxation: Recursively remove problematic constraints (like 'format').
                    // We now PRESERVE 'required' and 'type' for model awareness.
                    loosenSchema(fn.parameters);

                    // Ensure the tool name is what the model expects (original name)
                    if (toolCopy.function) toolCopy.function.name = originalName;
                    else toolCopy.name = originalName;
                    namespacedTools.push(toolCopy);
                }
                fs.writeFileSync(toolsPath, JSON.stringify(namespacedTools, null, 2));
                toolBridgeEnv.TOOL_BRIDGE_TOOLS = toolsPath;
            }
            if (req.body.mcpServers) {
                const mcpPath = path.join(turnTempDir, 'mcp_servers.json');
                fs.writeFileSync(mcpPath, JSON.stringify(req.body.mcpServers, null, 2));
                toolBridgeEnv.TOOL_BRIDGE_MCP_SERVERS = mcpPath;
            }
            mcpServers = { 'ionosphere-tool-bridge': { command: 'node', args: [TOOL_BRIDGE_PATH], env: toolBridgeEnv, trust: true } };
        }

        const generationConfig = {};
        if (req.body.max_tokens !== undefined) generationConfig.maxOutputTokens = req.body.max_tokens;
        if (req.body.max_completion_tokens !== undefined) generationConfig.maxOutputTokens = req.body.max_completion_tokens;
        if (req.body.temperature !== undefined) generationConfig.temperature = req.body.temperature;
        if (req.body.top_p !== undefined) generationConfig.topP = req.body.top_p;
        if (req.body.stop) {
            generationConfig.stopSequences = Array.isArray(req.body.stop) ? req.body.stop : [req.body.stop];
        }

        // Map OpenAI reasoning_effort to Gemini thinkingConfig
        const reasoningEffort = req.body.reasoning_effort;
        if (reasoningEffort) {
            generationConfig.thinkingConfig = {
                includeThoughts: true
            };
            if (reasoningEffort === 'low') {
                generationConfig.thinkingConfig.thinkingBudget = 4096;
            } else if (reasoningEffort === 'medium') {
                generationConfig.thinkingConfig.thinkingBudget = 16384;
            } else if (reasoningEffort === 'high') {
                generationConfig.thinkingConfig.thinkingBudget = 32768;
            }
        }

        generateConfig({
            targetPath: settingsPath,
            mcpServers,
            modelName: req.body.model,
            generationConfig
        });

        const executeTask = async () => {
            let taskResolve;
            const executePromise = new Promise(r => taskResolve = r);
            globalPromiseMap.set(activeTurnId, executePromise);

            try {
                // Use fingerprint for concurrency gating to catch retries/metadata shifts
                activeTurnsByHash.set(fingerprint, activeTurnId);
                activeTurnsByHash.set(historyHash, activeTurnId);
                const promptText = (conversationPromptSection || conversationPrompt).trim();
                const promptSize = promptText.length;
                console.log(`[Turn ${activeTurnId}] Executing for fingerprint: ${fingerprint} (Prompt Size: ${promptSize} chars)`);

                if (promptSize > 300000) {
                    console.warn(`[Turn ${activeTurnId}] WARNING: Large prompt detected (${promptSize} chars). Model may experience drift or ignore recent instructions.`);
                }

                await controller.sendPrompt(activeTurnId, promptText, turnTempDir, settingsPath, systemMessage.trim(), allCallbacks, {
                    IONOSPHERE_IPC: ipcPath,
                    IONOSPHERE_HISTORY_HASH: historyHash,
                    IONOSPHERE_HISTORY_TOOLS: historicalTools.join(',')
                }, attachments);

                // Final safety for non-streaming multi-tool or parked turns
                if (!responseSent) {
                    if (accumulatedText.length === 0 && accumulatedToolCalls.length === 0) {
                        console.warn(`[Turn ${activeTurnId}] WARNING: No fresh text or tool calls accumulated for this turn. (API returned 0 tokens?)`);
                        // For non-streaming, we must send at least an empty response to avoid hanging the client
                        if (!isStreaming) {
                            onResult({ stats: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
                        } else {
                            // For streaming, send an empty text chunk then [DONE]
                            onText("");
                            onResult({ stats: {} });
                        }
                    } else if (!isStreaming) {
                        if (accumulatedToolCalls.length > 0) {
                            onResult({ stats: {} }); // Force completion with gathered tools
                        }
                    }
                }
            } finally {
                const parkedCount = parkedTurns.size;
                console.log(`[Turn ${activeTurnId}] Concluded. Active: ${currentlyRunning}/${MAX_CONCURRENT_CLI}, Parked: ${parkedCount}`);

                if (activeTurnsByHash.get(fingerprint) === activeTurnId) {
                    activeTurnsByHash.delete(fingerprint);
                }
                if (activeTurnsByHash.get(historyHash) === activeTurnId) {
                    activeTurnsByHash.delete(historyHash);
                }
                parkedTurns.delete(activeTurnId);
                globalPromiseMap.delete(activeTurnId);
                if (taskResolve) taskResolve();
                ipcServer.close();
                if (process.platform !== 'win32') {
                    try { if (fs.existsSync(ipcPath)) fs.unlinkSync(ipcPath); } catch (_) { }
                }
                fs.rmSync(turnTempDir, { recursive: true, force: true });
            }
        };

        await enqueueControllerPrompt(executeTask);

    } catch (err) {
        console.error(`[API Error] Critical failure in /v1/chat/completions: ${err.stack || err.message}`);
        const errorObj = formatErrorResponse(err);
        if (!res.headersSent) {
            res.status(getStatusCode(errorObj)).json({ error: errorObj });
        }
        else res.end();
    }
});

const MODELS_LIST = [
    { id: "auto-gemini-3", context_window: 700000, description: "Auto-selects an appropriate Gemini 3.0 model, and fallbacks if unavailable." },
    { id: "auto-gemini-2.5", context_window: 700000, description: "Auto-selects an appropriate Gemini 2.5 model, and fallbacks if unavailable." },
    { id: "gemini-3-pro-preview", context_window: 700000, description: "Gemini 3.0 Pro Preview" },
    { id: "gemini-3.1-pro-preview", context_window: 700000, description: "Gemini 3.1 Pro Preview" },
    { id: "gemini-3-flash-preview", context_window: 700000, description: "Gemini 3.0 Flash Preview" },
    { id: "gemini-2.5-pro", context_window: 700000, description: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", context_window: 700000, description: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", context_window: 700000, description: "Gemini 2.5 Flash Lite" },
    { id: "gemini-2.0-flash", context_window: 700000, description: "Gemini 2.0 Flash" }
];

app.get('/v1/models', (req, res) => {
    // Baseline timestamp for "modern" Gemini models
    const created = 1715731200; // May 15, 2024 (Gemini 1.5 stable)

    res.json({
        object: "list",
        data: MODELS_LIST.map(m => ({
            id: m.id,
            object: "model",
            created: created,
            owned_by: "google",
            context_window: m.context_window,
            description: m.description,
            permission: [
                {
                    id: `modelperm-${randomUUID()}`,
                    object: "model_permission",
                    created: created,
                    allow_create_engine: false,
                    allow_sampling: true,
                    allow_logprobs: true,
                    allow_search_indices: false,
                    allow_view: true,
                    allow_fine_tuning: false,
                    organization: "*",
                    group: null,
                    is_blocking: false
                }
            ]
        }))
    });
});

app.get('/v1/models/:model', (req, res) => {
    const created = 1715731200;
    const modelId = req.params.model;
    const model = MODELS_LIST.find(m => m.id === modelId);

    if (model) {
        return res.json({
            id: model.id,
            object: "model",
            created: created,
            owned_by: "google",
            context_window: model.context_window,
            description: model.description,
            permission: [
                {
                    id: `modelperm-${randomUUID()}`,
                    object: "model_permission",
                    created: created,
                    allow_create_engine: false,
                    allow_sampling: true,
                    allow_logprobs: true,
                    allow_search_indices: false,
                    allow_view: true,
                    allow_fine_tuning: false,
                    organization: "*",
                    group: null,
                    is_blocking: false
                }
            ]
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
