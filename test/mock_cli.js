/**
 * test/mock_cli.js — Updated Mock CLI
 *
 * Emits the real Gemini CLI stream-json event types so tests reflect
 * actual CLI behavior discovered from live output.
 *
 * Usage: controlled by CLI_SCENARIO env var
 *   text        — simple text response (default)
 *   tool_use    — emits a tool_use + tool_result + text
 *   error       — emits an error event
 *   slow        — emits text with a delay (for concurrency tests)
 */

const SCENARIO = process.env.CLI_SCENARIO || 'text';
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

async function run() {
    // Always emit init
    emit({ type: 'init', timestamp: new Date().toISOString(), session_id: 'mock-session-001', model: 'gemini-test' });
    emit({ type: 'message', role: 'user', content: 'mock user message' });

    if (SCENARIO === 'tool_use') {
        emit({
            type: 'tool_use',
            timestamp: new Date().toISOString(),
            tool_name: 'get_weather',
            tool_id: 'get_weather-mock-001',
            parameters: { city: 'London' }
        });
        emit({
            type: 'tool_result',
            timestamp: new Date().toISOString(),
            tool_id: 'get_weather-mock-001',
            status: 'success',
            output: 'Sunny, 22°C'
        });
        emit({ type: 'message', role: 'assistant', content: 'The weather in London is sunny and 22°C.', delta: true });
        emit({ type: 'result', status: 'success', stats: { total_tokens: 120, input_tokens: 80, output_tokens: 40, duration_ms: 1000, tool_calls: 1 } });

    } else if (SCENARIO === 'error') {
        emit({ type: 'error', message: 'Mock CLI error', code: 'MOCK_ERROR' });

    } else if (SCENARIO === 'slow') {
        await delay(200);
        emit({ type: 'message', role: 'assistant', content: 'Slow response chunk 1', delta: true });
        await delay(200);
        emit({ type: 'message', role: 'assistant', content: ' chunk 2', delta: true });
        emit({ type: 'result', status: 'success', stats: { total_tokens: 50, input_tokens: 30, output_tokens: 20, duration_ms: 500, tool_calls: 0 } });

    } else {
        // Default: simple text response
        emit({ type: 'message', role: 'assistant', content: 'Hello! ', delta: true });
        emit({ type: 'message', role: 'assistant', content: 'This is a mock response.', delta: true });
        emit({ type: 'result', status: 'success', stats: { total_tokens: 100, input_tokens: 60, output_tokens: 40, duration_ms: 500, tool_calls: 0 } });
    }
}

run().catch(err => {
    process.stderr.write(`[mock_cli] Error: ${err.message}\n`);
    process.exit(1);
});
