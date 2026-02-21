import { streamIonosphereProvider } from '../packages/pi-provider/streamAdapter.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
    process.env.IONOSPHERE_URL = 'http://localhost:3000/v1/chat/completions';

    console.log("[TEST] Starting backend server...");
    const serverProcess = spawn('node', ['src/index.js'], {
        stdio: 'inherit',
        env: {
            ...process.env,
            PORT: "3000",
            // Point directly to the test wrapper script
            GEMINI_CLI_PATH: path.resolve(__dirname, 'mock_cli.cmd'),
        }
    });

    await new Promise(res => setTimeout(res, 2000)); // Wait for server to bind

    // We only need basic context for the test
    const mockContext = {
        messages: [{ role: 'user', content: 'Call the echo tool now.' }]
    };

    console.log("[TEST] Invoking stream adapter via POST /v1/chat/completions");
    try {
        const generator = streamIonosphereProvider("gemini-cli", mockContext);

        for await (const chunk of generator) {
            console.log(`[PI-AI YIELD]`, chunk);

            // Validate the pi-ai syntax on tool calls
            if (chunk.type === 'toolcall_delta') {
                if (typeof chunk.args !== 'string') {
                    console.error("FATAL: Adapter failed supervisor constraint: Tool call arguments must be a JSON string.");
                    process.exit(1);
                }
            }
        }

    } catch (e) {
        console.error("Adapter failed:", e);
    } finally {
        serverProcess.kill();
    }
}

runTest();
