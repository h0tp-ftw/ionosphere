import { expect } from 'chai';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('WebSocket Framed Pipe (Native Pi-AI Provider)', function () {
    this.timeout(15000);

    let serverProcess;
    let ws;
    const PORT = 3001;

    before(function (done) {
        // Start the Ionosphere server on a test port
        serverProcess = spawn('node', ['src/index.js'], {
            env: {
                ...process.env,
                PORT: PORT.toString(),
                GEMINI_CLI_PATH: 'node', // Use node to execute our mock CLI
            }
        });

        serverProcess.stdout.on('data', (data) => {
            console.log(`[SERVER STDOUT] ${data.toString().trim()}`);
            if (data.toString().includes(`listening on port ${PORT}`)) {
                done();
            }
        });

        serverProcess.stderr.on('data', (data) => {
            console.error(`[SERVER STDERR] ${data.toString().trim()}`);
        });
    });

    after(function () {
        if (ws) ws.close();
        if (serverProcess) serverProcess.kill();
    });

    it('should connect to /v1/stream, initialize, and stream a ReAct loop', function (done) {
        ws = new WebSocket(`ws://localhost:${PORT}/v1/stream`);

        let framesReceived = [];
        let toolCallId = null;

        ws.on('open', () => {
            // Send the INIT payload
            ws.send(JSON.stringify({
                execution_id: 'test-exec-1',
                type: 'init',
                data: {
                    prompt: 'Call the echo tool now.',
                    // Hack to override the args inside WebSocketController to point to the mock CLI file
                    mcpServers: {
                        dummy: {
                            command: path.resolve(__dirname, 'mock_cli.js'),
                            args: []
                        }
                    }
                }
            }));
        });

        ws.on('message', (data) => {
            const rawFrame = data.toString();
            console.log(`[TEST WS RCVD] ${rawFrame}`);

            // Verify envelope integrity
            let envelope;
            try {
                envelope = JSON.parse(rawFrame);
            } catch (e) {
                return done(new Error(`Received malformed JSON frame: ${rawFrame}`));
            }

            if (envelope.execution_id !== 'test-exec-1') return;

            const parsed = envelope.data || {};
            framesReceived.push({ type: envelope.type, data: parsed });

            // Phase 1: Wait for the CLI to emit a toolCall
            if (envelope.type === 'frame' && parsed.type === 'toolCall' && parsed.functionCall && parsed.functionCall.name === 'echo') {
                toolCallId = parsed.toolCallId;

                // Phase 2: Simulate Pi-AI returning the reverse-tunnel Tool Result
                const toolResultPayload = {
                    execution_id: 'test-exec-1',
                    type: 'tool_result',
                    data: {
                        type: 'toolResult',
                        toolCallId: toolCallId,
                        content: [{ type: 'text', text: 'hello world from echo' }]
                    }
                };

                ws.send(JSON.stringify(toolResultPayload));
            }

            // Phase 3: Wait for the CLI to gracefully exit
            if (envelope.type === 'done') {
                expect(parsed.code).to.equal(0);

                // Verify we saw the tool call and some text emission
                const hasToolCall = framesReceived.some(f => f.type === 'frame' && f.data?.type === 'toolCall');
                const hasText = framesReceived.some(f => f.type === 'frame' && f.data?.type === 'text');

                // The AI should have called the tool and then generated text after receiving the result
                expect(hasToolCall, 'Should have emitted a toolCall').to.be.true;
                expect(hasText, 'Should have emitted text content').to.be.true;

                done();
            }

            if (envelope.type === 'error') {
                done(new Error(`Received explicitly error over stream: ${parsed.message}`));
            }
        });
    });
});
