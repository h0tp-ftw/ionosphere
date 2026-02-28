/**
 * test/spawn_spy.js
 *
 * A thin spy script used in place of the real Gemini CLI.
 * When spawned, it:
 *   1. Writes its argv (args after node + script path) to SPAWN_SPY_ARGS_FILE
 *   2. Reads all stdin and writes it to SPAWN_SPY_STDIN_FILE
 *   3. Emits a minimal valid stream-json response so GeminiController resolves cleanly
 */
import fs from 'fs';

const argsFile = process.env.SPAWN_SPY_ARGS_FILE;
const stdinFile = process.env.SPAWN_SPY_STDIN_FILE;

// Write spawn args (skip node + script path itself)
const capturedArgs = process.argv.slice(2);
if (argsFile) {
    fs.writeFileSync(argsFile, JSON.stringify(capturedArgs), 'utf-8');
}

// Read stdin
let stdinData = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { stdinData += chunk; });
await new Promise(resolve => process.stdin.once('end', resolve));

if (stdinFile) {
    fs.writeFileSync(stdinFile, stdinData, 'utf-8');
}

// Emit a minimal valid stream-json sequence so GeminiController's Promise resolves
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
emit({ type: 'init', session_id: 'spy-session', model: 'spy' });
emit({ type: 'message', role: 'assistant', content: 'spy response', delta: true });
emit({ type: 'result', status: 'success', stats: { total_tokens: 10, input_tokens: 5, output_tokens: 5, duration_ms: 1, tool_calls: 0 } });
