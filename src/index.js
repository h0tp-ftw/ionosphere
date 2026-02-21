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

const MAX_CONCURRENT_CLI = parseInt(process.env.MAX_CONCURRENT_CLI) || 5;
let currentlyRunning = 0;
const requestQueue = [];

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
                        console.log(`[GC] Sweeping abandoned workspace: ${entry.name}`);
                        fs.rmSync(dirPath, { recursive: true, force: true });
                    }
                }
            }
        }
    } catch (e) {
        console.error(`[GC] Sweeper error:`, e);
    }
}, 5 * 60 * 1000); // Run every 5 minutes

// Process Safety: Ensure zombies are killed
process.on('SIGINT', () => {
    process.exit(0);
});
process.on('SIGTERM', () => {
    process.exit(0);
});

const handleUpload = (req, res, next) => {
    if (req.is('multipart/form-data')) {
        upload.any()(req, res, next);
    } else {
        next();
    }
};

app.post('/v1/chat/completions', handleUpload, async (req, res) => {
    try {
        // 1. Authorization Check
        const expectedApiKey = process.env.API_KEY;
        if (expectedApiKey) {
            const authHeader = req.headers['authorization'];
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: { message: "Missing or formatted improperly Authorization header. Use 'Bearer <YOUR_API_KEY>'" } });
            }
            const providedKey = authHeader.substring(7);
            if (providedKey !== expectedApiKey) {
                return res.status(401).json({ error: { message: "Invalid API Key" } });
            }
        }

        const turnId = req.turnId || randomUUID();
        const turnTempDir = path.join(baseTempDir, turnId);
        if (!fs.existsSync(turnTempDir)) {
            fs.mkdirSync(turnTempDir, { recursive: true });
        }

        let messages = req.body.messages;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: "Missing 'messages' array in request payload" });
        }

        let systemMessage = "";
        let conversationPrompt = "";
        let imageCounter = 0;

        for (const msg of messages) {
            if (msg.role === 'system') {
                let text = Array.isArray(msg.content) ? msg.content.map(p => p.type === 'text' ? p.text : '').join('') : msg.content;
                systemMessage += sanitizePromptText(text) + "\n\n";
            } else {
                let textContent = "";
                let inlinedFiles = "";

                if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'text') {
                            textContent += sanitizePromptText(part.text);
                        } else if (part.type === 'image_url' && part.image_url && part.image_url.url && part.image_url.url.startsWith('data:image/')) {
                            const b64Data = part.image_url.url.split(',')[1];
                            if (b64Data) {
                                imageCounter++;
                                const mimePart = part.image_url.url.split(';')[0];
                                const ext = mimePart.includes('/') ? mimePart.split('/')[1] : 'png';
                                const imagePath = path.join(turnTempDir, `image_${imageCounter}.${ext}`);

                                // Buffer decoding of the base64 string
                                fs.writeFileSync(imagePath, Buffer.from(b64Data, 'base64'));

                                // Inject the file reference directly (clean @path format)
                                textContent = "@" + imagePath + "\n" + textContent;
                            }
                        }
                    }
                } else {
                    textContent = sanitizePromptText(msg.content || "");
                }

                if (msg.role === 'user') {
                    conversationPrompt += `USER: ${textContent}\n\n`;
                } else if (msg.role === 'assistant') {
                    let content = textContent;
                    // Explicitly narrate the tool call so the CLI remembers its action
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        for (const tc of msg.tool_calls) {
                            const name = tc.function?.name || tc.name || 'unknown';
                            const args = tc.function?.arguments || tc.arguments || '{}';
                            content += `\n[ACTION: Called tool '${name}' with args: ${args}]`;
                        }
                    }
                    conversationPrompt += `ASSISTANT: ${content.trim()}\n\n`;
                } else if (msg.role === 'tool' || msg.role === 'function') {
                    const toolName = msg.name || msg.tool_call_id || 'unknown';
                    conversationPrompt += `[TOOL RESULT (${toolName})]:\n${textContent}\n\n`;
                }
            }
        }

        let prompt = conversationPrompt.trim();
        let system = systemMessage.trim() || "";

        if (!prompt) {
            return res.status(400).json({ error: "No user messages provided in conversation" });
        }

        // Parse OpenAI tool definitions — forwarded to ToolBridge for MCP registration
        const openAiTools = req.body.tools || null;

        // Per-turn IPC socket for ToolBridge ↔ Bridge communication
        // On Windows: named pipe; on Unix: domain socket in the turn workspace.
        const ipcPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\ionosphere-${turnId}`
            : path.join(turnTempDir, 'tool_ipc.sock');

        // pendingToolCalls: maps a unique tool call key to its resolve/reject pair.
        // When the ToolBridge signals a tool_call over IPC, the bridge pends it here
        // and immediately emits the SSE chunk. When the client's next request arrives
        // with a matching tool result, it resolves the pending promise so the bridge
        // can reply to the ToolBridge, which then returns the result to the CLI.
        //
        // NOTE: In the stateless request-boundary model the CLI turn *ends* after the
        // tool call SSE is sent. The IPC server is kept alive between turns so that
        // if the CLI somehow keeps running (e.g. multi-step agentic loops), it can
        // receive the result without restarting.
        const pendingToolCalls = new Map();

        // IPC server — each connection is one tool dispatch from the ToolBridge.
        const ipcServer = net.createServer((socket) => {
            let buf = '';
            socket.on('data', (chunk) => {
                buf += chunk.toString();
                const nl = buf.indexOf('\n');
                if (nl === -1) return;
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);

                let msg;
                try { msg = JSON.parse(line); } catch (e) {
                    console.error('[IPC] Malformed message:', line);
                    return;
                }

                if (msg.event === 'tool_call') {
                    const callKey = randomUUID();
                    console.log(`[IPC] Tool call received: ${msg.name} (key=${callKey})`);

                    // Emit SSE tool_call chunk to client immediately
                    onToolCall({
                        id: `call_${callKey.substring(0, 8)}`,
                        name: msg.name,
                        arguments: typeof msg.arguments === 'string'
                            ? msg.arguments
                            : JSON.stringify(msg.arguments ?? {})
                    });

                    // Store the socket so we can reply when the result arrives
                    pendingToolCalls.set(callKey, { socket, name: msg.name });

                    // Surface the pending call key in the response so that
                    // the NEXT request can include it in role:tool messages
                    // (the OpenAI client handles this automatically via tool_call_id)
                }
            });

            socket.on('error', (err) => {
                console.error('[IPC] Socket error:', err.message);
            });
        });

        // Helper: resolve a pending tool call with a result string.
        // Called from the conversation parser when a role:tool message is encountered
        // whose tool_call_id matches a live pending call.
        const resolveToolCall = (callKey, result) => {
            const pending = pendingToolCalls.get(callKey);
            if (!pending) return false;
            pendingToolCalls.delete(callKey);
            try {
                pending.socket.write(JSON.stringify({ event: 'tool_result', result: String(result) }) + '\n');
                pending.socket.end();
            } catch (e) {
                console.error('[IPC] Failed to write tool result:', e.message);
            }
            return true;
        };

        // Attempt to listen; if socket already exists (crash recovery), remove it first
        await new Promise((res, rej) => {
            ipcServer.listen(ipcPath, res);
            ipcServer.on('error', (err) => {
                if (err.code === 'EADDRINUSE' && process.platform !== 'win32') {
                    fs.unlinkSync(ipcPath);
                    ipcServer.listen(ipcPath, res);
                } else {
                    rej(err);
                }
            });
        });
        console.log(`[API] IPC server listening at ${ipcPath}`);

        // Resolve upstream MCP servers from the request.
        // These are passed to ToolBridge via TOOL_BRIDGE_MCP_SERVERS — NOT injected
        // directly into settings.json. This ensures ALL tool calls flow through the
        // ToolBridge aggregator → IPC → SSE → client. The CLI never reaches upstream
        // MCP servers directly, preserving full client observability and control.
        let mcpServers = null;
        let upstreamMcpServers = null;
        const rawMcp = req.body.mcpServers || (req.body.extra_body && req.body.extra_body.mcpServers);
        if (rawMcp) {
            try {
                upstreamMcpServers = typeof rawMcp === 'string' ? JSON.parse(rawMcp) : rawMcp;
            } catch (e) {
                console.warn(`[API] Failed to parse mcpServers block: ${e.message}`);
            }
        }

        // Determine if ToolBridge is needed for this turn
        const hasOpenAiTools = openAiTools && openAiTools.length > 0;
        const hasUpstreamMcp = upstreamMcpServers && Object.keys(upstreamMcpServers).length > 0;

        if (hasOpenAiTools || hasUpstreamMcp) {
            const toolBridgeEnv = { TOOL_BRIDGE_IPC: ipcPath };

            if (hasOpenAiTools) {
                const toolsFilePath = path.join(turnTempDir, 'tools.json');
                fs.writeFileSync(toolsFilePath, JSON.stringify(openAiTools), 'utf-8');
                toolBridgeEnv.TOOL_BRIDGE_TOOLS = toolsFilePath;
                console.log(`[API] ToolBridge: ${openAiTools.length} OpenAI tool(s) registered.`);
            }

            if (hasUpstreamMcp) {
                const mcpServersFilePath = path.join(turnTempDir, 'mcp_servers.json');
                fs.writeFileSync(mcpServersFilePath, JSON.stringify(upstreamMcpServers), 'utf-8');
                toolBridgeEnv.TOOL_BRIDGE_MCP_SERVERS = mcpServersFilePath;
                console.log(`[API] ToolBridge: aggregating ${Object.keys(upstreamMcpServers).length} upstream MCP server(s).`);
            }

            // ToolBridge is the ONLY mcpServers entry in settings.json.
            // All tool routing goes through it — upstream MCPs are invisible to the CLI.
            mcpServers = {
                'ionosphere-tool-bridge': {
                    command: 'node',
                    args: [TOOL_BRIDGE_PATH],
                    env: toolBridgeEnv
                }
            };
        }


        // Parse optional custom settings payload (e.g. modelConfigs)
        let customSettings = null;
        if (req.body.customSettings) {
            try {
                customSettings = typeof req.body.customSettings === 'string'
                    ? JSON.parse(req.body.customSettings)
                    : req.body.customSettings;
            } catch (e) {
                console.warn(`[API] Failed to parse customSettings block: ${e.message}`);
            }
        }

        // Dynamically inject generation parameters
        if (req.body.temperature !== undefined || req.body.top_p !== undefined || req.body.max_tokens !== undefined) {
            customSettings = customSettings || {};
            const reqModel = req.body.model || 'gemini-2.5-flash-lite';

            customSettings.modelConfigs = {
                customAliases: {
                    "request-override": {
                        extends: reqModel,
                        modelConfig: {
                            generateContentConfig: {
                                ...(req.body.temperature !== undefined && { temperature: req.body.temperature }),
                                ...(req.body.top_p !== undefined && { topP: req.body.top_p }),
                                ...(req.body.max_tokens !== undefined && { maxOutputTokens: req.body.max_tokens })
                            }
                        }
                    }
                },
                overrides: [
                    {
                        match: { model: "*" },
                        modelConfig: { model: "request-override" }
                    }
                ]
            };
        }

        const settingsDir = path.join(turnTempDir, '.gemini');
        const settingsPath = path.join(settingsDir, 'settings.json');

        // Extract requested model routing
        let modelName = req.body.model;

        // Generate and write settings for this specific turn
        generateConfig({ targetPath: settingsPath, mcpServers, customSettings, modelName });

        // Disable Request/Response Socket Timeouts for very long ReAct loops
        req.setTimeout(0);
        res.setTimeout(0);

        // Check if the client disconnected before we started
        if (req.closed) {
            console.log(`[API] Client disconnected before prompt was enqueued for turn ${turnId}.`);
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Ensure connection stays alive via heartbeat ping every 15s
        const heartbeatInterval = setInterval(() => {
            if (!res.writableEnded) {
                res.write(': ping\n\n');
            }
        }, 15000);

        // Inject any multipart file uploads directly into the prompt string
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                prompt = `@${file.path}\n` + prompt;
            }
        }

        const sanitizedPrompt = prompt;
        if (process.env.DEBUG_IONOSPHERE) {
            console.log(`[DEBUG] Final Prompt:\n${sanitizedPrompt}`);
            console.log(`[DEBUG] Settings Path: ${settingsPath}`);
            console.log(`[DEBUG] Settings Content:\n${fs.readFileSync(settingsPath, 'utf8')}`);
        }

        // Helper to format SSE
        const sendChunk = (chunk) => {
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
        };

        // Wire up event listeners for this specific request
        const onText = (text) => {
            process.stdout.write(text);
            sendChunk({
                id: `chatcmpl-${turnId}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'gemini-cli',
                choices: [{
                    index: 0,
                    delta: { content: text }
                }]
            });
        };

        const onToolCall = (info) => {
            console.log(`\n[Tool Call] ${JSON.stringify(info)}`);
            // Emit the tool call delta
            sendChunk({
                id: `chatcmpl-${turnId}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'gemini-cli',
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: info.id || `call_${randomUUID().substring(0, 8)}`,
                            type: 'function',
                            function: {
                                name: info.name,
                                arguments: info.arguments
                            }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            });
        };

        const onError = (err) => {
            console.error(`\n[Error]`, err);
            sendChunk({ error: err });

            if (err.code === 'AUTH_EXPIRED') {
                process.exit(1);
            }
        };

        const onResult = (json) => {
            console.log(`\n[Turn Result]`, json);
            if (!res.writableEnded) {
                // Emit token usage from CLI stats if available
                const stats = json.stats || {};
                const usageChunk = {
                    id: `chatcmpl-${turnId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: 'gemini-cli',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: {
                        prompt_tokens: stats.input_tokens ?? stats.input ?? 0,
                        completion_tokens: stats.output_tokens ?? 0,
                        total_tokens: stats.total_tokens ?? 0
                    }
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
            removeListeners();
        };

        const onEvent = (json) => {
            // Unmapped events are discarded for SSE
        };

        const removeListeners = () => {
            clearInterval(heartbeatInterval);
            // Tear down IPC server — reject any pending tool calls
            if (ipcServer.listening) {
                ipcServer.close(() => {
                    if (process.platform !== 'win32' && fs.existsSync(ipcPath)) {
                        try { fs.unlinkSync(ipcPath); } catch (_) { }
                    }
                });
            }
            for (const [key, pending] of pendingToolCalls.entries()) {
                try { pending.socket.destroy(); } catch (_) { }
            }
            pendingToolCalls.clear();
        };

        const cleanupWorkspace = (retryCount = 0) => {
            try {
                if (!fs.existsSync(turnTempDir)) return;
                fs.rmSync(turnTempDir, { recursive: true, force: true });
            } catch (e) {
                if ((e.code === 'EPERM' || e.code === 'EBUSY') && retryCount < 3) {
                    setTimeout(() => cleanupWorkspace(retryCount + 1), 2000);
                } else {
                    console.error(`[API] Clean up failed for turn ${turnId}:`, e.message);
                }
            }
        };

        const cleanup = () => {
            removeListeners();
        };

        // Handle client drops mid-generation.
        // Only remove listeners and cancel the process — do NOT delete the workspace yet,
        // as it may still be needed by the queued sendPrompt call.
        let aborted = false;
        res.on('close', () => {
            if (!res.writableEnded) {
                aborted = true;
                console.warn(`[API] Client disconnected mid-stream for turn ${turnId}!`);
                controller.cancelCurrentTurn(turnId);
                removeListeners();
            }
        });

        console.log(`\n[API] Enqueueing prompt sequence for turn ${turnId} in workspace ${turnTempDir}...`);

        const executeTask = async () => {
            if (aborted) {
                cleanupWorkspace();
                return;
            }
            try {
                await controller.sendPrompt(turnId, sanitizedPrompt, turnTempDir, settingsPath, system, {
                    onText, onToolCall, onError, onResult, onEvent
                });
            } finally {
                cleanupWorkspace();
            }
        };

        enqueueControllerPrompt(executeTask).catch(err => {
            console.error(`[API Controller Error]`, err);
            cleanupWorkspace();
        });

    } catch (err) {
        console.error("[API Error]", err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.end();
        }
    }
});

app.get('/health', (req, res) => {
    res.json({ status: "ok" });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nIonosphere Orchestrator HTTP Interface listening on port ${PORT}`);
    console.log(`Example: curl -X POST http://localhost:${PORT}/v1/chat/completions -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}]}'\n`);
});
