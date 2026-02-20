import express from 'express';
import multer from 'multer';
import { GeminiController } from './GeminiController.js';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// Setup multer so files stream directly into our existing temp/ directory
const upload = multer({ dest: path.join(process.cwd(), 'temp') });

const PORT = process.env.PORT || 3000;

console.log("Starting Gemini Ionosphere (Session-Aware Mode)...");
const controller = new GeminiController();

app.post('/v1/prompt', upload.array('files'), async (req, res) => {
    try {
        // Support JSON fallback if it's not a multipart request
        const prompt = req.body.prompt;

        if (!prompt) {
            return res.status(400).json({ error: "Missing 'prompt' in request payload" });
        }

        // Disable Request/Response Socket Timeouts for very long ReAct loops
        req.setTimeout(0);
        res.setTimeout(0);

        // Check if the client disconnected before we started
        if (req.closed) {
            console.log("[API] Client disconnected before prompt was enqueued.");
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
            console.log(`[API] Received ${req.files.length} injected files via multipart.`);
            for (const file of req.files) {
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

            // Clean up multipart temp files
            if (req.files) {
                for (const file of req.files) {
                    try {
                        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                    } catch (e) { /* ignore */ }
                }
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
                console.warn("[API] Client disconnected mid-stream!");
                controller.cancelCurrentTurn();
                cleanup();
            }
        });

        console.log(`\n[API] Enqueueing prompt sequence...`);
        controller.sendPrompt(finalPrompt);

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
