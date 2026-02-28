/**
 * test/stdin_prompt.test.js
 *
 * Tests for the stdin-based prompt delivery approach in GeminiController.
 *
 * Covers:
 *  1. Spawn args — no temp @file ref in -p, no -p at all without attachments
 *  2. Prompt text is delivered via stdin (echo via spawn_spy.js)
 *  3. Large prompts (>2000 lines) are NOT truncated — full text arrives at the CLI
 *  4. Binary attachments still go as @refs in -p flag
 *  5. No temp prompt file left on disk after sendPrompt completes
 *  6. stdin + attachments coexist (both reach the CLI)
 *
 * Spawn inspection uses test/spawn_spy.js (a real child process) instead of
 * monkey-patching because ESM named exports are read-only live bindings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { GeminiController } from '../src/GeminiController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'mock_cli.js');
const SPAWN_SPY = path.join(__dirname, 'spawn_spy.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Spawns the mock CLI directly and pipes promptText to its stdin.
 * Returns { stdout, stderr, code }.
 */
function spawnMockCli(scenario, promptText, extraArgs = [], env = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', [MOCK_CLI, ...extraArgs], {
            env: { ...process.env, CLI_SCENARIO: scenario, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.stdin.end(promptText, 'utf-8');

        proc.on('close', (code) => resolve({ stdout, stderr, code }));
        proc.on('error', reject);
    });
}

/**
 * Runs sendPrompt via GeminiController with GEMINI_CLI_PATH pointing at
 * spawn_spy.js, which writes its received args + stdin to temp files.
 * Returns { args: string[], stdinText: string }.
 */
async function runWithSpy(promptText, attachments = [], extraEnv = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ionos-spy-'));
    const argsFile = path.join(tmpDir, 'args.json');
    const stdinFile = path.join(tmpDir, 'stdin.txt');
    const settingsFile = path.join(tmpDir, 'settings.json');

    // Write a placeholder settings file (GeminiController just passes the path)
    fs.writeFileSync(settingsFile, '{}');

    // GeminiController reads GEMINI_CLI_PATH from process.env directly (not from extraEnv).
    // We temporarily set it to spawn_spy.js, which records args and stdin to files.
    const originalCliPath = process.env.GEMINI_CLI_PATH;
    process.env.GEMINI_CLI_PATH = `node ${SPAWN_SPY}`;

    const controller = new GeminiController(tmpDir);
    await controller.sendPrompt(
        `spy-turn-${Date.now()}`,
        promptText,
        tmpDir,
        settingsFile,
        null, // systemPrompt
        {},   // callbacks (no-op)
        {
            // These are passed to the spawned child process env
            SPAWN_SPY_ARGS_FILE: argsFile,
            SPAWN_SPY_STDIN_FILE: stdinFile,
            ...extraEnv,
        },
        attachments,
    );

    // Restore original CLI path
    if (originalCliPath === undefined) {
        delete process.env.GEMINI_CLI_PATH;
    } else {
        process.env.GEMINI_CLI_PATH = originalCliPath;
    }

    const args = fs.existsSync(argsFile)
        ? JSON.parse(fs.readFileSync(argsFile, 'utf-8'))
        : [];
    const stdinText = fs.existsSync(stdinFile)
        ? fs.readFileSync(stdinFile, 'utf-8')
        : '';

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { args, stdinText };
}

/** Parse JSONL stdout into an array of objects. */
function parseJsonl(raw) {
    return raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
}

// ─── 1. Spawn arg inspection: no attachments ──────────────────────────────────

test('GeminiController - stdin:pipe - no -p flag when no attachments', async () => {
    const { args } = await runWithSpy('hello world');

    assert.ok(!args.includes('-p'),
        'No -p flag should be present when there are no attachments');
    assert.ok(!args.some(a => a.includes('prompt-') && a.endsWith('.txt')),
        'No temp prompt .txt file reference should appear in spawn args');
});

test('GeminiController - stdin:pipe - standard flags are still present', async () => {
    const { args } = await runWithSpy('sanity check');

    assert.ok(args.includes('-y'), 'Should include -y flag');
    assert.ok(args.includes('-o'), 'Should include -o flag');
    assert.ok(args.includes('stream-json'), 'Should include stream-json output format');
});

// ─── 2. Prompt text flows through stdin ───────────────────────────────────────

test('GeminiController - stdin:pipe - prompt text arrives in stdin', async () => {
    const promptText = 'This is the exact prompt text that should arrive via stdin.';
    const { stdinText } = await runWithSpy(promptText);

    assert.equal(stdinText, promptText,
        'The full prompt text should arrive unmodified via stdin');
});

// ─── 3. Large prompt (>2000 lines) passes intact ─────────────────────────────

test('GeminiController - stdin:pipe - large 3000-line prompt is NOT truncated', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}: some content here`);
    const bigPrompt = lines.join('\n');

    const { stdinText } = await runWithSpy(bigPrompt);

    assert.equal(stdinText.length, bigPrompt.length,
        `Full ${bigPrompt.length} bytes should arrive — not capped at 2000 lines`);
    assert.equal(stdinText.split('\n').length, 3000,
        'All 3000 lines should arrive intact');
});

// ─── 4. Attachments still go via -p as @refs ─────────────────────────────────

test('GeminiController - stdin:pipe - attachments appear as @refs in -p', async () => {
    const fakeAttachment = '/tmp/fake-image.png';
    const { args } = await runWithSpy('describe this image', [fakeAttachment]);

    const pIndex = args.indexOf('-p');
    assert.ok(pIndex !== -1, '-p flag should be present when attachments are provided');
    const pValue = args[pIndex + 1];
    assert.ok(pValue.includes('@' + fakeAttachment),
        `-p value should contain @ref to the attachment, got: ${pValue}`);
    assert.ok(!pValue.includes('prompt-') || !pValue.endsWith('.txt'),
        'No temp prompt .txt file reference should appear in the -p value');
});

test('GeminiController - stdin:pipe - prompt text arrives ALSO when attachments are present', async () => {
    const promptText = 'Describe the image attached.';
    const { stdinText, args } = await runWithSpy(promptText, ['/tmp/fake.png']);

    // Both should be present
    assert.equal(stdinText, promptText, 'Prompt text should still come through stdin');
    assert.ok(args.includes('-p'), '-p flag should be present for the attachment');
});

// ─── 5. No temp prompt file left on disk ─────────────────────────────────────

test('GeminiController - stdin:pipe - no temp prompt-*.txt file left on disk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ionos-nofile-'));
    const settingsFile = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsFile, '{}');

    const filesBefore = new Set(fs.readdirSync(tmpDir));

    const controller = new GeminiController(tmpDir);
    await controller.sendPrompt(
        `nofile-turn-${Date.now()}`,
        'no temp files please',
        tmpDir,
        settingsFile,
        null, {}, {}, []
    );

    const filesAfter = fs.readdirSync(tmpDir);
    const newFiles = filesAfter.filter(f => !filesBefore.has(f));
    const tempPromptFiles = newFiles.filter(f => f.startsWith('prompt-') && f.endsWith('.txt'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.equal(tempPromptFiles.length, 0,
        `No prompt-*.txt files should remain on disk. Found: ${tempPromptFiles.join(', ')}`);
});

// ─── 6. mock_cli stdin_echo round-trips ──────────────────────────────────────

test('mock_cli stdin_echo - receives piped text intact', async () => {
    const promptText = 'This is the exact prompt text that should arrive via stdin.';
    const { stdout, code } = await spawnMockCli('stdin_echo', promptText);

    assert.equal(code, 0, 'mock CLI should exit cleanly');

    const lines = parseJsonl(stdout);
    const msg = lines.find(l => l.type === 'message' && l.role === 'assistant');
    assert.ok(msg, 'Should have an assistant message');
    assert.ok(msg.content.startsWith('STDIN_RECEIVED:'),
        'Content should begin with STDIN_RECEIVED marker');

    const [, lengthStr, preview] = msg.content.split(':');
    assert.equal(Number(lengthStr), promptText.length,
        'Reported stdin byte length should match the prompt text length');
    assert.ok(preview.startsWith(promptText.substring(0, 50).replace(/\n/g, '\\n')),
        'Preview should match the start of the prompt text');
});

test('mock_cli stdin_echo - large prompt (3000 lines) survives untruncated', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}: some content here`);
    const bigPrompt = lines.join('\n');

    const { stdout, code } = await spawnMockCli('stdin_echo', bigPrompt);
    assert.equal(code, 0);

    const events = parseJsonl(stdout);
    const msg = events.find(l => l.type === 'message' && l.role === 'assistant');
    assert.ok(msg, 'Should have assistant message');

    const [, lengthStr] = msg.content.split(':');
    assert.equal(Number(lengthStr), bigPrompt.length,
        `Full ${bigPrompt.length} bytes should arrive, not a 2000-line truncation`);
});

test('mock_cli stdin_echo - stdin arrives correctly even with extra CLI args present', async () => {
    const promptText = 'Describe the attached image.';
    const { stdout, code } = await spawnMockCli('stdin_echo', promptText, ['-p', '@/tmp/fake.png']);

    assert.equal(code, 0);
    const events = parseJsonl(stdout);
    const msg = events.find(l => l.type === 'message' && l.role === 'assistant');
    assert.ok(msg, 'Should have assistant message');

    const [, lengthStr] = msg.content.split(':');
    assert.equal(Number(lengthStr), promptText.length,
        'stdin text should arrive correctly even when extra CLI args are present');
});
