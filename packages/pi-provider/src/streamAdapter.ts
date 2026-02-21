import { createParser } from 'eventsource-parser';

export async function* streamIonosphereProvider(model: any, context: any, options: any) {
    // 1. STRICT DELEGATION: We intentionally DO NOT forward mcpServers.
    // This forces the Gemini CLI to act purely as the reasoning brain, 
    // delegating ALL tool execution to OpenClaw on the host machine.
    const payload = {
        messages: context.messages,
        stream: true
        // mcpServers intentionally omitted.
    };

    const response = await fetch("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!response.body) {
        throw new Error("No response body returned from stream endpoint");
    }

    const queue: any[] = [];
    let isStreamDone = false;
    let streamError: any = null;

    // 2. Strict mapping to pi-ai format
    const parser = createParser({
        onEvent: (event) => {
            if (event.data === '[DONE]') {
                isStreamDone = true;
                return;
            }
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.choices?.[0]?.delta?.content) {
                    queue.push({ type: 'text_delta', text: parsed.choices[0].delta.content });
                } else if (parsed.choices?.[0]?.delta?.tool_calls) {
                    const tc = parsed.choices[0].delta.tool_calls[0];
                    queue.push({
                        type: 'toolcall_delta',
                        toolCallId: tc.id,
                        name: tc.function.name,
                        args: tc.function.arguments // Kept as raw string for pi-ai
                    });
                }
            } catch (e) { streamError = e; }
        }
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
        while (true) {
            while (queue.length > 0) yield queue.shift();
            if (isStreamDone || streamError) break;

            const { done, value } = await reader.read();
            if (done) break;

            parser.feed(decoder.decode(value, { stream: true }));
        }

        while (queue.length > 0) yield queue.shift();
        if (streamError) throw streamError;

    } finally {
        reader.releaseLock();
    }
}
