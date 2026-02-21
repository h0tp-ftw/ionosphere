/**
 * Mock Gemini CLI for testing the Ionosphere WebSocket Framed Pipe.
 * Simulates NDJSON output formatting and reverse-tunnel stdin reading.
 */



console.log('Mock CLI Started'); // Should be ignored (not NDJSON)
console.error('Some STDERR log');

setTimeout(() => {
    // 1. Emit some initial text
    console.log(JSON.stringify({ type: "text", value: "Let me check that for you." }));

    // 2. Emit a tool call
    console.log(JSON.stringify({
        type: "toolCall",
        toolCallId: "call_123",
        functionCall: { name: "echo", args: { text: "hello world" } }
    }));

    // 3. Wait for stdin (reverse tunnel tool result)
    process.stdin.on('data', (data) => {
        const input = data.toString().trim();
        if (input.includes('toolResult')) {
            // 4. Emit final text and close
            console.log(JSON.stringify({ type: "text", value: "The tool said hello world." }));
            console.log(JSON.stringify({ type: "done", code: 0 }));
            process.exit(0);
        }
    });

}, 500);
