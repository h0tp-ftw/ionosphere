import { streamIonosphereProvider } from '../packages/pi-provider/src/streamAdapter.ts';
import { Readable } from 'stream';

const mockResponse = {
    ok: true,
    status: 200,
    body: {
        getReader: () => {
            const encoder = new TextEncoder();
            const chunks = [
                `data: ${JSON.stringify({
                    id: 'chatcmpl-123',
                    object: 'chat.completion.chunk',
                    model: 'gemini-cli',
                    choices: [{ index: 0, delta: { content: 'Starting...' } }]
                })}\n\n`,
                `data: ${JSON.stringify({
                    id: 'chatcmpl-123',
                    object: 'chat.completion.chunk',
                    model: 'gemini-cli',
                    choices: [{
                        index: 0, delta: {
                            tool_calls: [
                                { id: 'call_abc123', function: { name: 'echo', arguments: '{"text":"hello world"}' } }
                            ]
                        }
                    }]
                })}\n\n`,
                `data: [DONE]\n\n`
            ];

            let i = 0;
            return {
                read: async () => {
                    if (i < chunks.length) {
                        return { done: false, value: encoder.encode(chunks[i++]) };
                    }
                    return { done: true, value: undefined };
                }
            };
        }
    }
};

// Override global fetch to return our mock
global.fetch = async () => mockResponse;

async function run() {
    try {
        console.log("Starting stream adapter evaluation...");
        const iterator = streamIonosphereProvider("gemini-cli", {
            messages: [{ role: 'user', content: 'test tool format' }]
        });

        for await (const chunk of iterator) {
            console.log("PI-AI Adapter Output:", chunk);
        }
        console.log("Evaluation complete. All chunks passed through adapter.");
    } catch (e) {
        console.error("Adapter failed:", e);
    }
}

run();
