import express from 'express';
import multer from 'multer';
import net from 'net';
import { GeminiController } from './GeminiController.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { generateConfig } from '../scripts/generate_settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the tool-bridge MCP server entry point
const TOOL_BRIDGE_PATH = path.resolve(__dirname, '..', 'packages', 'tool-bridge', 'index.js');

const app = express();
app.use(express.json());

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
// parkedTurns: turnId -> { controller, executePromise, resolveTask, cleanupWorkspace }
const parkedTurns = new Map();

const MAX_CONCURRENT_CLI = parseInt(process.env.MAX_CONCURRENT_CLI) || 5;
let currentlyRunning = 0;
const requestQueue = [];

// Helper: resolve a pending tool call with a result string.
// If the callKey matches a parked turn, it unblocks the CLI logic.
const resolveToolCall = (callKey, result) => {
    const pending = pendingToolCalls.get(callKey);
    if (!pending) return false;
    pendingToolCalls.delete(callKey);
    try {
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
                return res.status(401).json({ error: { message: "Missing or formatted improperly Authorization header." } });
            }
            if (authHeader.substring(7) !== expectedApiKey) {
                return res.status(401).json({ error: { message: "Invalid API Key" } });
            }
        }

        let messages = req.body.messages;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: "Missing 'messages' array" });
        }

        // 2. Identify "Handoff" (Warm Stateless Continuity)
        // If the last message is a TOOL result, check if we have a parked turn for it.
        const lastMsg = messages[messages.length - 1];
        let hijackedTurnId = null;
        if (lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'function')) {
            const callId = lastMsg.tool_call_id;
            const shortKey = callId?.startsWith('call_') ? callId.substring(5) : callId;

            // Find the full callKey in pendingToolCalls
            for (const [callKey, pending] of pendingToolCalls.entries()) {
                if (callKey.startsWith(shortKey)) {
                    hijackedTurnId = pending.turnId;
                    break;
                }
            }
        }

        // SSE Setup
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        req.setTimeout(0);
        res.setTimeout(0);

        const sendChunk = (chunk) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        const heartbeatInterval = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
        }, 15000);

        const onText = (text) => {
            sendChunk({
                id: `chatcmpl-stream`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'gemini-cli',
                choices: [{ index: 0, delta: { content: text } }]
            });
        };

        const onToolCall = (info) => {
            sendChunk({
                id: `chatcmpl-stream`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'gemini-cli',
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
            }
            clearInterval(heartbeatInterval);
        };

        const onError = (err) => {
            sendChunk({ error: err });
            if (!res.writableEnded) res.end();
            clearInterval(heartbeatInterval);
        };

        const onResult = (json) => {
            const stats = json.stats || {};
            sendChunk({
                id: `chatcmpl-stream`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'gemini-cli',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: stats.input_tokens || 0,
                    completion_tokens: stats.output_tokens || 0,
                    total_tokens: stats.total_tokens || 0
                }
            });
            if (!res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
            }
            clearInterval(heartbeatInterval);
        };

        // --- HANDOFF CASE ---
        if (hijackedTurnId && parkedTurns.has(hijackedTurnId)) {
            console.log(`[API] Warm Handoff: Hijacking turn ${hijackedTurnId} for tool result`);
            const parked = parkedTurns.get(hijackedTurnId);

            // 1. Update callbacks to pipe output to THIS response
            controller.updateCallbacks(hijackedTurnId, { onText, onToolCall, onError, onResult });

            // 2. Unblock the CLI via IPC
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
                return res.status(404).json({ error: "Tool call not found or already resolved" });
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
        let conversationPrompt = "";
        let imageCounter = 0;

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemMessage += sanitizePromptText(msg.content) + "\n\n";
            } else {
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

                if (msg.role === 'user') conversationPrompt += `USER: ${text}\n\n`;
                else if (msg.role === 'assistant') {
                    let content = text;
                    if (msg.tool_calls) {
                        for (const tc of msg.tool_calls) {
                            content += `\n[ACTION: Called tool '${tc.function?.name || tc.name}' with args: ${tc.function?.arguments || tc.arguments}]`;
                        }
                    }
                    conversationPrompt += `ASSISTANT: ${content.trim()}\n\n`;
                } else if (msg.role === 'tool' || msg.role === 'function') {
                    conversationPrompt += `[TOOL RESULT (${msg.name || msg.tool_call_id})]:\n${text}\n\n`;
                }
            }
        }

        // Per-turn IPC
        const ipcPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\ionosphere-${turnId}`
            : path.join(turnTempDir, 'tool_ipc.sock');

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
                            pendingToolCalls.set(callKey, { socket, turnId });

                            // Map the turn to 'parked' so next request can hijack it
                            const currentParked = parkedTurns.get(turnId);
                            if (currentParked) {
                                // Already parked, just need to update tool callback
                                controller.callbacksByTurn.get(turnId)?.onToolCall({
                                    id: callId, name: msg.name, arguments: msg.arguments
                                });
                            } else {
                                // This tool call will end the current TURN's HTTP response
                                controller.callbacksByTurn.get(turnId)?.onToolCall({
                                    id: callId, name: msg.name, arguments: msg.arguments
                                });
                            }
                        }
                    } catch (e) { }
                }
            });
        });

        await new Promise((resolve) => {
            ipcServer.listen(ipcPath, () => resolve());
            ipcServer.on('error', () => { if (process.platform !== 'win32') fs.unlinkSync(ipcPath); ipcServer.listen(ipcPath, () => resolve()); });
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
            mcpServers = { 'ionosphere-tool-bridge': { command: 'node', args: [TOOL_BRIDGE_PATH], env: toolBridgeEnv } };
        }

        const onEvent = (json) => {
            console.log(`[Turn ${turnId}] CLI Event: ${json.type}`);
        };

        generateConfig({ targetPath: settingsPath, mcpServers, modelName: req.body.model });

        const executeTask = async () => {
            let taskResolve;
            const executePromise = new Promise(r => taskResolve = r);
            parkedTurns.set(turnId, { controller, executePromise, cleanupWorkspace: () => fs.rmSync(turnTempDir, { recursive: true, force: true }) });

            try {
                await controller.sendPrompt(turnId, conversationPrompt.trim(), turnTempDir, settingsPath, systemMessage.trim(), {
                    onText, onToolCall, onError, onResult, onEvent
                });
            } finally {
                parkedTurns.delete(turnId);
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

app.get('/health', (req, res) => res.json({ status: "ok" }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ionosphere Orchestrator listening on port ${PORT}`);
});
