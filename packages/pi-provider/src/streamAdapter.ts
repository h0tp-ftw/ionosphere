import WebSocket from 'ws';
import { randomUUID } from 'crypto';

// True Multiplexing State
let ws: WebSocket | null = null;
const executionQueues = new Map<string, any[]>();
const executionResolvers = new Map<string, () => void>();
let globalSocketError: Error | null = null;

async function getSharedSocket(wsUrl: string): Promise<WebSocket> {
    if (ws && ws.readyState === WebSocket.OPEN) {
        return ws;
    }

    return new Promise((resolve, reject) => {
        globalSocketError = null;
        ws = new WebSocket(wsUrl);

        ws.on('open', () => resolve(ws!));

        ws.on('message', (data) => {
            try {
                const envelope = JSON.parse(data.toString());
                const execId = envelope.execution_id;
                if (!execId) return; // Drop malformed envelopes

                const queue = executionQueues.get(execId);
                if (queue) {
                    queue.push(envelope);
                    const resolver = executionResolvers.get(execId);
                    if (resolver) {
                        resolver();
                        executionResolvers.delete(execId);
                    }
                }
            } catch (e) {
                // Ignore non-envelope noise
            }
        });

        ws.on('close', () => {
            // In true multiplexing, backend doesn't close on completion, only on fatal failure.
            for (const [id, resolver] of executionResolvers.entries()) {
                const q = executionQueues.get(id);
                if (q) q.push({ execution_id: id, type: 'socket_closed' });
                resolver();
            }
            executionResolvers.clear();
        });

        ws.on('error', (err) => {
            globalSocketError = err instanceof Error ? err : new Error(String(err));
            for (const resolver of executionResolvers.values()) resolver();
            executionResolvers.clear();
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

    // In Pi-AI ReAct loops, we rely on the client thread ID for multiplex continuity
    const executionId = context.threadId || randomUUID();
    const isToolResult = lastMsg && lastMsg.role === 'tool';

    // Initialize execution queue for this specific stream generator
    if (!executionQueues.has(executionId)) {
        executionQueues.set(executionId, []);
    }

    const wsUrl = process.env.IONOSPHERE_WS_URL || 'ws://localhost:3000/v1/stream';
    const socket = await getSharedSocket(wsUrl);

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
            execution_id: executionId,
            type: 'init',
            data: {
                modelConfig: model,
                systemPrompt: systemPrompt.trim(),
                prompt: prompt.trim(),
                mcpServers: context.mcpServers || {}
            }
        }));
    } else {
        // Continuing ReAct loop
        // Map the Pi-AI tool result into the schema expected by our WebSocketController
        const content = lastMsg.content;
        const toolResults = Array.isArray(content) ? content : [{ type: 'text', text: content }];

        socket.send(JSON.stringify({
            execution_id: executionId,
            type: 'tool_result',
            data: {
                type: 'toolResult',
                toolCallId: lastMsg.tool_call_id || "unknown",
                content: toolResults
            }
        }));
    }

    yield { type: 'assistant_start' };

    // The inner queue consumer loop to convert Multiplexed WebSocket push -> AsyncGenerator pull
    const waitForData = () => new Promise<void>(resolve => {
        const queue = executionQueues.get(executionId) || [];
        if (queue.length > 0 || globalSocketError) return resolve();
        executionResolvers.set(executionId, resolve);
    });

    try {
        let isDone = false;

        while (!isDone) {
            await waitForData();

            if (globalSocketError) {
                throw globalSocketError;
            }

            const queue = executionQueues.get(executionId) || [];

            while (queue.length > 0) {
                const envelope = queue.shift()!;

                if (envelope.type === 'socket_closed') {
                    isDone = true;
                    break;
                }

                if (envelope.type === 'error') {
                    throw new Error(envelope.data?.message || "Gemini CLI Backend Error");
                }

                if (envelope.type === 'done') {
                    // The generation loop completed natively and no further tools were requested
                    isDone = true;
                    break;
                }

                if (envelope.type === 'frame') {
                    const parsed = envelope.data;

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
                    }
                }
            }
        }
    } finally {
        executionQueues.delete(executionId);
        executionResolvers.delete(executionId);
        yield { type: 'assistant_end' };
    }
}
