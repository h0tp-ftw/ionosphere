/**
 * test/mock_cli.js — Exhaustive Mock CLI
 */
import net from 'net';
import fs from 'fs';

const SCENARIO = process.env.CLI_SCENARIO || 'text';
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

async function run() {
    emit({ type: 'init', timestamp: new Date().toISOString(), session_id: 'mock-session-001', model: 'gemini-test' });

    if (SCENARIO === 'tool_use' || SCENARIO === 'tool_park') {
        const ipcPath = process.env.IONOSPHERE_IPC || process.env.TOOL_BRIDGE_IPC;
        if (ipcPath) {
            const client = net.connect(ipcPath, () => {
                client.write(JSON.stringify({ event: 'tool_call', name: 'get_weather', arguments: '{"city":"London"}' }) + '\n');
            });
            client.on('data', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.event === 'tool_result') {
                    emit({ type: 'tool_result', timestamp: new Date().toISOString(), tool_id: 'mock_tc_1', status: 'success', output: msg.result });
                    emit({ type: 'message', role: 'assistant', content: `Final answer: The weather in London is ${msg.result}.`, delta: true });
                    emit({ type: 'result', status: 'success', stats: { total_tokens: 100, input_tokens: 50, output_tokens: 50, duration_ms: 10, tool_calls: 1 } });
                    process.exit(0);
                }
            });
            // If it's a park scenario, we don't exit, we wait for the result which might come in a later process hijack
            await new Promise(() => { });
        }
    } else if (SCENARIO === 'vision') {
        emit({ type: 'message', role: 'assistant', content: 'I see a beautiful landscape with mountains.', delta: true });
        emit({ type: 'result', status: 'success', stats: { total_tokens: 150, input_tokens: 100, output_tokens: 50, duration_ms: 200, tool_calls: 0 } });
    } else if (SCENARIO === 'auth_error') {
        console.error("Fatal: please log in to continue. (Simulated auth error)");
        process.exit(1);
    } else if (SCENARIO === 'quota_error') {
        console.error("Fatal: RESOURCE_EXHAUSTED. (Simulated quota error)");
        process.exit(1);
    } else if (SCENARIO === 'false_auth_path') {
        console.error('Error executing tool list_directory: Path not in workspace: Attempted path "/home/ubuntu/openclaw/extensions/google-gemini-cli-auth" resolves outside allowed workspace directories.');
        process.exit(1);
    } else if (SCENARIO === 'crash') {
        console.error("Simulated crash: SEGFAULT at 0x000");
        process.exit(1);
    } else if (SCENARIO === 'error') {
        console.error('[mock_cli] Simulating a fatal error');
        process.exit(1);
    } else if (SCENARIO === 'long_text') {
        for (let i = 0; i < 5; i++) {
            emit({ type: 'message', role: 'assistant', content: `Paragraph ${i + 1}. This is some long text to test streaming stability and accumulation. `, delta: true });
            await delay(50);
        }
        emit({ type: 'result', status: 'success', stats: { total_tokens: 500, input_tokens: 50, output_tokens: 450, duration_ms: 300, tool_calls: 0 } });
    } else {
        // Default text
        emit({ type: 'message', role: 'assistant', content: 'Hello! This is a mock response.', delta: true });
        emit({ type: 'result', status: 'success', stats: { total_tokens: 100, input_tokens: 50, output_tokens: 50, duration_ms: 10, tool_calls: 0 } });
    }
}

run().catch(err => {
    process.stderr.write(`[mock_cli] Error: ${err.message}\n`);
    process.exit(1);
});
