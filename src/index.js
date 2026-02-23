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
 * Traditional hash is very sensitive.
 */
const getHistoryHash = (messages) => {
    const serialized = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content, name: m.name, tool_call_id: m.tool_call_id })));
    return createHash('sha256').update(serialized).digest('hex');
};

/**
 * A more stable identifier that ignores slight metadata or "thinking" changes.
 * Useful for catching retries that might have slightly different history.
 */
const getConversationFingerprint = (messages) => {
    // Stable Turn Anchor: based on the FIRST user message and system prompt
    // This is more resilient to history truncation/sliding windows.
    const systemMsg = messages.find(m => m.role === 'system');

    // Find the FIRST user message
    const firstUserMsg = messages.find(m => m.role === 'user');

    const extractText = (content) => {
        if (!content) return "";
        let text = "";
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
            text = content.map(p => (typeof p === 'object' && p.type === 'text') ? p.text : "").join("");
        }

        // Drift Resistance: Try to isolate the core <user_message>
        const userMsgMatch = text.match(/<user_message>([\s\S]*?)<\/user_message>/);
        if (userMsgMatch) return userMsgMatch[1].trim();

        // Fallback: Strip known dynamic blocks like <environment_details>
        return text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "").trim();
    };

    const system = extractText(systemMsg?.content);
    const firstUser = extractText(firstUserMsg?.content);

    // Hash the purified content (first 500 chars)
    return createHash('sha256').update(`${system.substring(0, 100)}:${firstUser.substring(0, 500)}`).digest('hex').substring(0, 12);
};

const logRequestForensics = (req) => {
    if (process.env.GEMINI_DEBUG_HANDOFF !== 'true') return;
    const { method, url, headers, body } = req;
    const msgCount = body.messages?.length || 0;
    const lastMsg = body.messages?.[msgCount - 1];
    console.log(`[FORENSICS] ${method} ${url}`);
    console.log(`[FORENSICS] Headers: ${JSON.stringify({
        'user-agent': headers['user-agent'],
        'x-request-id': headers['x-request-id'],
        'content-length': headers['content-length']
    })}`);
    console.log(`[FORENSICS] Message Count: ${msgCount}`);
    if (lastMsg) {
        console.log(`[FORENSICS] Last Msg Role: ${lastMsg.role}`);
        const contentStr = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
        console.log(`[FORENSICS] Last Msg Content (first 100 chars): ${contentStr.substring(0, 100)}...`);
    }
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
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        console.log(`[IPC] Sending result to turn ${pending.turnId} for tool ${callKey}`);
        pending.socket.write(JSON.stringify({ event: 'tool_result', result: resultStr }) + '\n');
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

        logRequestForensics(req);

        const historyHash = getHistoryHash(messages);
        const fingerprint = getConversationFingerprint(messages);

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
        let hijackedTurnId = null;

        const byHash = activeTurnsByHash.get(historyHash);
        const byFinger = activeTurnsByHash.get(fingerprint);

        if (byHash) {
            hijackedTurnId = byHash;
            console.log(`[HIJACK] Exact Hash Match (Thread Safe): Turn ${hijackedTurnId}`);
        } else if (byFinger && parkedTurns.has(byFinger)) {
            // Priority: If the turn is already Parked, we MUST hijack it to deliver the next message (approval/data)
            hijackedTurnId = byFinger;
            console.log(`[HIJACK] Fingerprint Match (Parked Turn): Turn ${hijackedTurnId}`);
        } else if (byFinger && lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function')) {
            hijackedTurnId = byFinger;
            console.log(`[HIJACK] Fingerprint Anchor Match (Tool Continuation): Turn ${hijackedTurnId}`);
        } else if (byFinger) {
            // New Instruction Case: We have a fingerprint match but the hash is different.
            // Under the One Session Rule, we will PREEMPT (kill) the old turn and start a NEW one.
            const oldTurnId = byFinger;
            console.log(`[API] One Session Rule: Preempting old turn ${oldTurnId} for new instruction on fingerprint ${fingerprint}`);
            controller.cancelCurrentTurn(oldTurnId);
            // We wait a tiny bit for the cleanup to start, then proceed to NEW TURN logic
            await new Promise(r => setTimeout(r, 200));
        }

        if (!hijackedTurnId && lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function')) {
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
            if (responseSent) return;
            if (process.env.GEMINI_DEBUG_RESPONSES === 'true') {
                console.log(`[Turn ${activeTurnId}] SSE Text Chunk: ${text.substring(0, 50)}...`);
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
            if (responseSent) return;
            console.log(`[Turn ${activeTurnId}] Dispatching Tool Call: ${info.name} (${info.id})`);

            const toolCall = {
                id: info.id,
                type: 'function',
                function: { name: info.name, arguments: info.arguments }
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
            if (responseSent) return;
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
            if (responseSent) return;
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

        const onEvent = (json) => {
            console.log(`[Turn ${activeTurnId}] CLI Event: ${json.type}`);
        };

        const onPark = (msg) => {
            if (responseSent) return;
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
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                };
                res.json(payload);
            }
            responseSent = true;
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        const allCallbacks = { onText, onToolCall, onError, onResult, onEvent, onPark };

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
                hijackedTurnId = activeTurnsByHash.get(historyHash) || activeTurnsByHash.get(fingerprint);
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
            controller.updateCallbacks(hijackedTurnId, allCallbacks);

            // 2. Resolve or Re-emit
            // Deep-scan: Check if ANY message in the current payload is a tool result for our pending calls
            let resolvedAny = false;
            for (const msg of messages) {
                if (msg.role === 'tool' || msg.role === 'function') {
                    const callId = msg.tool_call_id;
                    const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;
                    for (const [callKey] of pendingToolCalls.entries()) {
                        if (callKey.startsWith(shortKey)) {
                            console.log(`[API] Deep-scan match: Resolving ${callId} for turn ${hijackedTurnId}`);
                            resolveToolCall(callKey, msg.content);
                            resolvedAny = true;
                            break;
                        }
                    }
                }
            }

            if (!resolvedAny) {
                // If no results found in messages, it might be a Proxy Hijack (Retry)
                // Re-emit the pending tool call so the client knows we are still waiting
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
                    console.warn(`[API] Proxy Hijack: No pending tool call found for Turn ${hijackedTurnId}. Falling back.`);
                }
            }

            // 3. Await the conclusion of the TASK from the new request side
            await parked.executePromise;
            return;
        }


        // --- NEW TURN CASE ---
        const turnTempDir = path.join(baseTempDir, activeTurnId);
        if (!fs.existsSync(turnTempDir)) fs.mkdirSync(turnTempDir, { recursive: true });

        // Serialize history (Strict Stateless Narrator)
        let systemMessage = "";
        let conversationPromptSection = ""; // Renamed to avoid shadowed top-level historyHash if any
        let imageCounter = 0;

        // Find the LAST user message to identify which one needs environment details
        const userMessages = messages.filter(m => m.role === 'user');
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

                    if (msg.role === 'user') {
                        // History Deduplication: Strip environment details from non-latest messages to prevent prompt bloat
                        if (msg !== lastUserMsg) {
                            text = text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "[Environment details stripped for brevity]");
                        }
                        conversationPromptSection += `USER: ${text}\n\n`;
                    }
                    else if (msg.role === 'assistant') {
                        let content = text;
                        if (msg.tool_calls) {
                            for (const tc of msg.tool_calls) {
                                const callId = tc.id || tc.tool_call_id || 'unknown';
                                let toolName = tc.function?.name || tc.name || 'unknown';
                                // Ensure history identity: All our tools should be parked under ionosphere__
                                if (!toolName.includes('__') && !toolName.startsWith('ionosphere__')) {
                                    toolName = `ionosphere__${toolName}`;
                                }

                                // Handle both string arguments (OpenAI format) and object arguments (accumulatedToolCalls)
                                const argsStr = typeof (tc.function?.arguments || tc.arguments) === 'string'
                                    ? (tc.function?.arguments || tc.arguments)
                                    : JSON.stringify(tc.function?.arguments || tc.arguments || {});

                                content += `\n<action id="${callId}">Called tool '${toolName}' with args: ${argsStr}</action>`;
                            }
                        }
                        conversationPromptSection += `ASSISTANT: ${content.trim()}\n\n`;
                    } else if (msg.role === 'tool' || msg.role === 'function') {
                        const callId = msg.tool_call_id || 'unknown';
                        const resultStr = typeof text === 'string' ? text : JSON.stringify(text);
                        conversationPromptSection += `<result id="${callId}">\n${resultStr}\n</result>\n\n`;
                    }
                }
            }
        }

        // Collect historical tool calls to help Repeat Breaker ignore echoes
        const historicalTools = [];
        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const toolName = tc.function?.name || tc.name;
                    const rawArgs = tc.function?.arguments || tc.arguments || "{}";
                    const toolArgs = JSON.stringify(typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs);
                    historicalTools.push(`${historyHash}:${toolName}:${toolArgs}`);
                }
            }
        }

        // Debug Persistence: Create directory if needed
        if (process.env.GEMINI_DEBUG_PROMPTS === 'true') {
            const debugDir = path.join(process.cwd(), 'debug_prompts');
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        }

        // Per-turn IPC: Use /tmp for Unix sockets to avoid host-mount incompatibilities (ENOTSUP)
        const ipcPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\ionosphere-${activeTurnId}`
            : path.join('/tmp', `ionosphere-${activeTurnId}.sock`);

        const ipcServer = net.createServer((socket) => {
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

                            // Prefix stripping: send ORIGINAL names to the client (Roo Code)
                            const clientToolName = msg.name.startsWith('ionosphere__') ? msg.name.substring(12) : msg.name;

                            pendingToolCalls.set(callKey, {
                                socket,
                                turnId: activeTurnId,
                                name: msg.name, // Real namespaced name for the model
                                arguments: msg.arguments
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
                            }

                            // Trigger dispatcher
                            const callbacks = controller.callbacksByTurn.get(activeTurnId);
                            if (callbacks) {
                                callbacks.onToolCall({
                                    id: callId,
                                    name: clientToolName,
                                    arguments: msg.arguments
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
        if (process.env.GEMINI_DEBUG_PROMPTS === 'true') {
            fs.writeFileSync(path.join(turnTempDir, 'request.json'), JSON.stringify(req.body, null, 2));
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
                // Uniform Namespacing: Prefix names in tools.json so the model sees ionosphere__ prefix
                const namespacedTools = openAiTools.map(t => {
                    const name = t.function?.name || t.name;
                    if (t.function) {
                        t.function.name = name.startsWith('ionosphere__') ? name : `ionosphere__${name}`;
                    } else {
                        t.name = name.startsWith('ionosphere__') ? name : `ionosphere__${name}`;
                    }
                    return t;
                });
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

        generateConfig({ targetPath: settingsPath, mcpServers, modelName: req.body.model });

        const executeTask = async () => {
            let taskResolve;
            const executePromise = new Promise(r => taskResolve = r);
            globalPromiseMap.set(activeTurnId, executePromise);

            try {
                // Use fingerprint for concurrency gating to catch retries/metadata shifts
                activeTurnsByHash.set(fingerprint, activeTurnId);
                console.log(`[Turn ${activeTurnId}] Executing for fingerprint: ${fingerprint}`);

                await controller.sendPrompt(activeTurnId, (conversationPromptSection || conversationPrompt).trim(), turnTempDir, settingsPath, systemMessage.trim(), allCallbacks, {
                    IONOSPHERE_IPC: ipcPath,
                    IONOSPHERE_HISTORY_HASH: historyHash,
                    IONOSPHERE_HISTORY_TOOLS: historicalTools.join(',')
                });

                // Final safety for non-streaming multi-tool or parked turns
                if (!responseSent) {
                    if (accumulatedText.length === 0 && accumulatedToolCalls.length === 0) {
                        console.warn(`[Turn ${activeTurnId}] WARNING: No fresh text or tool calls accumulated for this turn.`);
                    }
                    if (!isStreaming) {
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
                parkedTurns.delete(activeTurnId);
                globalPromiseMap.delete(activeTurnId);
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
