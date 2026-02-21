import WebSocket from 'ws';

// Module-level connection state to maintain session continuity during ReAct loops
let ws: WebSocket | null = null;
let wsQueue: string[] = [];
let wsResolver: (() => void) | null = null;
let isSocketDone = false;
let socketError: Error | null = null;

/**
 * Initializes or retrieves the existing WebSocket connection.
 * If isNewTurn is true, it forces a teardown of the old socket to ensure
 * Ionosphere spawns a fresh CLI context instance.
 */
async function getSocket(isNewTurn: boolean, wsUrl: string): Promise<WebSocket> {
    if (isNewTurn && ws) {
        try { ws.close(); } catch (e) { }
        ws = null;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        return ws;
    }

    return new Promise((resolve, reject) => {
        wsQueue = [];
        isSocketDone = false;
        socketError = null;
        wsResolver = null;

        ws = new WebSocket(wsUrl);

        ws.on('open', () => resolve(ws!));

        ws.on('message', (data) => {
            wsQueue.push(data.toString());
            if (wsResolver) {
                wsResolver();
                wsResolver = null;
            }
        });

        ws.on('close', () => {
            isSocketDone = true;
            if (wsResolver) {
                wsResolver();
                wsResolver = null;
            }
        });

        ws.on('error', (err) => {
            socketError = err instanceof Error ? err : new Error(String(err));
            isSocketDone = true;
            if (wsResolver) {
                wsResolver();
                wsResolver = null;
            }
            reject(err);
        });
    });
}

/**
 * The core adapter translating Gemini CLI NDJSON stdout chunks
 * into `pi-ai` structural AssistantMessageEventStream streams.
 */
export async function* streamIonosphereProvider(
    model: any,
    context: any,
    options?: any
): AsyncGenerator<any, void, unknown> {
    const messages = context.messages || [];
    const lastMsg = messages[messages.length - 1];

    // In Pi-AI ReAct loops, if the last message was a tool result,
    // we continue the existing thread instead of building a new initialization.
    const isToolResult = lastMsg && lastMsg.role === 'tool';

    const wsUrl = process.env.IONOSPHERE_WS_URL || 'ws://localhost:3000/v1/stream';
    const socket = await getSocket(!isToolResult, wsUrl);

    if (!isToolResult) {
        // Brand new invocation
        let systemPrompt = "";
        let prompt = "";

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemPrompt += msg.content + "\n";
            } else {
                const contentStr = typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content);
                prompt += `${msg.role.toUpperCase()}: ${contentStr}\n`;
            }
        }

        socket.send(JSON.stringify({
            type: 'init',
            modelConfig: model,
            systemPrompt: systemPrompt.trim(),
            prompt: prompt.trim(),
            mcpServers: context.mcpServers || {}
        }));
    } else {
        // Continuing ReAct loop
        // Map the Pi-AI tool result into the schema expected by our WebSocketController
        const content = lastMsg.content;
        const toolResults = Array.isArray(content) ? content : [{ type: 'text', text: content }];

        socket.send(JSON.stringify({
            type: 'tool_result',
            data: {
                type: 'toolResult',
                toolCallId: lastMsg.tool_call_id || "unknown",
                content: toolResults
            }
        }));
    }

    yield { type: 'assistant_start' };

    // The inner queue consumer loop to convert WebSocket push -> AsyncGenerator pull
    const waitForData = () => new Promise<void>(resolve => {
        if (wsQueue.length > 0 || isSocketDone || socketError) return resolve();
        wsResolver = resolve;
    });

    try {
        let isDone = false;

        while (!isDone) {
            await waitForData();

            if (socketError) {
                throw socketError;
            }

            while (wsQueue.length > 0) {
                const raw = wsQueue.shift()!;
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch (e) {
                    continue; // Skip noise
                }

                if (parsed.type === 'text') {
                    yield { type: 'text_start' };
                    yield { type: 'text_delta', delta: parsed.value };
                    yield { type: 'text_end' };
                } else if (parsed.type === 'toolCall') {
                    // Start tool call
                    yield {
                        type: 'toolcall_start',
                        toolCall: {
                            id: parsed.toolCallId,
                            name: parsed.functionCall?.name || 'unknown'
                        }
                    };

                    // Pipe the arguments JSON directly into delta payload
                    const argsString = JSON.stringify(parsed.functionCall?.args || {});
                    yield { type: 'toolcall_delta', delta: argsString };

                    // End tool call
                    yield { type: 'toolcall_end' };

                    // We must break to allow OpenClaw to execute the tool locally!
                    isDone = true;
                } else if (parsed.type === 'done') {
                    // The generation loop completed natively and no further tools were requested
                    isDone = true;
                    if (ws) {
                        try { ws.close(); } catch (e) { }
                        ws = null;
                    }
                } else if (parsed.type === 'error') {
                    throw new Error(parsed.message || "Gemini CLI Backend Error");
                }
            }

            if (isSocketDone && wsQueue.length === 0) {
                break;
            }
        }
    } finally {
        yield { type: 'assistant_end' };
    }
}
