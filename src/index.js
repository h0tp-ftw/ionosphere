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

console.log("Starting Gemini Native Orchestrator (Persistent Mode)...");
const controller = new GeminiController();

// We need to store active HTTP responses to stream chunks back to the client
let currentRes = null;
let heartbeatInterval = null;

controller.on('text', (text) => {
    process.stdout.write(text);
    if (currentRes && !currentRes.writableEnded) {
        currentRes.write(JSON.stringify({ type: 'text', value: text }) + '\n');
    }
});

controller.on('toolCall', (info) => {
    console.log(`\n[Tool Call] ${JSON.stringify(info)}`);
    if (currentRes && !currentRes.writableEnded) {
        currentRes.write(JSON.stringify({ type: 'toolCall', ...info }) + '\n');
    }
});

controller.on('error', (err) => {
    console.error(`\n[Fatal Error]`, err);
    if (currentRes && !currentRes.writableEnded) {
        currentRes.write(JSON.stringify({ type: 'error', error: err }) + '\n');
        currentRes.end();
    }

    // Auth errors are fatal and require the container/process to restart
    if (err.code === 'AUTH_EXPIRED') {
        process.exit(1);
    }
});

controller.on('done', () => {
    // We now rely on 'result' to be the definitive end of turn
});

controller.on('result', (json) => {
    console.log(`\n[Turn Result]`, json);
    if (currentRes && !currentRes.writableEnded) {
        currentRes.write(JSON.stringify(json) + '\n');
        currentRes.end();
    }
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    currentRes = null;
});

controller.on('close', (code) => {
    console.error(`\n[CLI Process Closed] Exit code ${code}. Restarting...`);
    // Simple self-healing: if the CLI dies, try to respawn it.
    controller.spawn();
    controller.waitForReady().catch(console.error);
});

// Start the CLI Subprocess
controller.spawn();

app.post('/v1/prompt', upload.array('files'), async (req, res) => {
    try {
        // Support JSON fallback if it's not a multipart request
        const prompt = req.body.prompt;

        if (!prompt) {
            return res.status(400).json({ error: "Missing 'prompt' in request payload" });
        }

        // 2) Disable Request/Response Socket Timeouts for very long ReAct loops
        req.setTimeout(0);
        res.setTimeout(0);

        // Wait for CLI to be ready
        await controller.waitForReady();

        // Check if the client disconnected before we even got the mutex lock
        if (req.closed) {
            console.log("[API] Client disconnected before prompt was enqueued.");
            return;
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Ensure connection stays alive via heartbeat ping every 15s
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (!res.writableEnded) {
                res.write(JSON.stringify({ type: "ping" }) + '\n');
            }
        }, 15000);

        currentRes = res;

        // 1) Zombie Process Cleanup: Handle client drops mid-generation
        req.on('close', () => {
            if (!res.writableEnded) {
                console.warn("[API] Client disconnected mid-stream!");
                if (heartbeatInterval) clearInterval(heartbeatInterval);

                // Send SIGINT to gracefully interrupt the CLI, triggering a FatalCancellationError 
                // which will release the Mutex cleanly via the {"type": "result"} object.
                controller.cancelCurrentTurn();
            }
        });

        // 3) Multi-part file injection gap
        let finalPrompt = "";

        // If multer successfully wrote files to `temp/`, we inject them as `@temp/file`
        if (req.files && req.files.length > 0) {
            console.log(`[API] Received ${req.files.length} injected files via multipart.`);
            for (const file of req.files) {
                // Ensure the file is tracked by the controller for GC
                controller.currentPromptFiles.push(file.path);
                finalPrompt += `@${file.path}\n`;
            }
        }

        finalPrompt += prompt;

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
    res.json({ status: "ok", ready: controller.ready });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nIonosphere Orchestrator HTTP Interface listening on port ${PORT}`);
    console.log(`Example: curl -X POST http://localhost:${PORT}/v1/prompt -H "Content-Type: application/json" -d '{"prompt":"Hello"}'\n`);
});
