import express from 'express';
import multer from 'multer';
import { GeminiController } from './GeminiController.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { generateConfig } from '../scripts/generate_settings.js';

const app = express();
app.use(express.json());

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

app.post('/v1/prompt', upload.array('files'), async (req, res) => {
    try {
        // Initialize turnId if no files were uploaded
        if (!req.turnId) {
            req.turnId = randomUUID();
        }

        const turnId = req.turnId;
        const turnTempDir = path.join(baseTempDir, turnId);
        if (!fs.existsSync(turnTempDir)) {
            fs.mkdirSync(turnTempDir, { recursive: true });
        }

        // Support JSON fallback if it's not a multipart request
        const prompt = req.body.prompt;

        if (!prompt) {
            return res.status(400).json({ error: "Missing 'prompt' in request payload" });
        }

        // Parse optional MCP Servers payload and generate isolated settings
        let mcpServers = null;
        if (req.body.mcpServers) {
            try {
                mcpServers = typeof req.body.mcpServers === 'string'
                    ? JSON.parse(req.body.mcpServers)
                    : req.body.mcpServers;
            } catch (e) {
                console.warn(`[API] Failed to parse mcpServers block: ${e.message}`);
            }
        }

        const settingsDir = path.join(turnTempDir, '.gemini');
        const settingsPath = path.join(settingsDir, 'settings.json');

        // Generate and write settings for this specific turn
        generateConfig({ targetPath: settingsPath, mcpServers });

        // Disable Request/Response Socket Timeouts for very long ReAct loops
        req.setTimeout(0);
        res.setTimeout(0);

        // Check if the client disconnected before we started
        if (req.closed) {
            console.log(`[API] Client disconnected before prompt was enqueued for turn ${turnId}.`);
            return;
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Ensure connection stays alive via heartbeat ping every 15s
        const heartbeatInterval = setInterval(() => {
            if (!res.writableEnded) {
                res.write(JSON.stringify({ type: "ping" }) + '\n');
            }
        }, 15000);

        // Build the full prompt (with any injected file references)
        let finalPrompt = "";
        if (req.files && req.files.length > 0) {
            console.log(`[API] Received ${req.files.length} injected files via multipart in turn ${turnId}.`);
            for (const file of req.files) {
                // file references are relative to the turn directory or absolute
                finalPrompt += `@${file.path}\n`;
            }
        }
        finalPrompt += prompt;

        // Wire up event listeners for this specific request
        const onText = (text) => {
            process.stdout.write(text);
            if (!res.writableEnded) {
                res.write(JSON.stringify({ type: 'text', value: text }) + '\n');
            }
        };

        const onToolCall = (info) => {
            console.log(`\n[Tool Call] ${JSON.stringify(info)}`);
            if (!res.writableEnded) {
                res.write(JSON.stringify({ type: 'toolCall', ...info }) + '\n');
            }
        };

        const onError = (err) => {
            console.error(`\n[Error]`, err);
            if (!res.writableEnded) {
                res.write(JSON.stringify({ type: 'error', error: err }) + '\n');
            }

            if (err.code === 'AUTH_EXPIRED') {
                process.exit(1);
            }
        };

        const onResult = (json) => {
            console.log(`\n[Turn Result]`, json);
            if (!res.writableEnded) {
                res.write(JSON.stringify(json) + '\n');
                res.end();
            }
            cleanup();
        };

        const onEvent = (json) => {
            if (!res.writableEnded) {
                res.write(JSON.stringify(json) + '\n');
            }
        };

        const cleanup = () => {
            clearInterval(heartbeatInterval);
            controller.removeListener('text', onText);
            controller.removeListener('toolCall', onToolCall);
            controller.removeListener('error', onError);
            controller.removeListener('result', onResult);
            controller.removeListener('event', onEvent);

            // Clean up the isolated workspace after the turn finishes
            try {
                if (fs.existsSync(turnTempDir)) {
                    fs.rmSync(turnTempDir, { recursive: true, force: true });
                }
            } catch (e) {
                console.error(`[API] Clean up failed for turn ${turnId}:`, e);
            }
        };

        controller.on('text', onText);
        controller.on('toolCall', onToolCall);
        controller.on('error', onError);
        controller.on('result', onResult);
        controller.on('event', onEvent);

        // Handle client drops mid-generation
        req.on('close', () => {
            if (!res.writableEnded) {
                console.warn(`[API] Client disconnected mid-stream for turn ${turnId}!`);
                controller.cancelCurrentTurn();
                cleanup();
            }
        });

        console.log(`\n[API] Enqueueing prompt sequence for turn ${turnId} in workspace ${turnTempDir}...`);

        // Pass the isolated directory and settings file to the controller
        controller.sendPrompt(finalPrompt, turnTempDir, settingsPath);

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nIonosphere Orchestrator HTTP Interface listening on port ${PORT}`);
    console.log(`Example: curl -X POST http://localhost:${PORT}/v1/prompt -H "Content-Type: application/json" -d '{"prompt":"Hello"}'\n`);
});
