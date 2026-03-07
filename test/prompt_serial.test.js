/**
 * test/prompt_serial.test.js
 *
 * Unit tests for the message serialization logic in src/index.js.
 * Extracts the serialization into a pure function for testability.
 *
 * Covers: system messages, user/assistant text, tool_calls narration,
 * role:tool results, image injection, and sanitization of @ / ! prefixes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Extracted serialization logic (mirrors src/index.js) ────────────────────

const sanitizePromptText = (text) => {
    if (typeof text !== 'string') return text;
    return text.split('\n').map(line => {
        if (line.startsWith('@') || line.startsWith('!')) {
            return '\\' + line;
        }
        return line;
    }).join('\n');
};

function serializeMessages(messages, turnTempDir) {
    let systemMessage = '';
    let conversationPrompt = '';
    let imageCounter = 0;

    // Filter only user messages to determine which is the last one
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];

    for (const msg of messages) {
        if (msg.role === 'system') {
            let text = Array.isArray(msg.content)
                ? msg.content.map(p => p.type === 'text' ? p.text : '').join('')
                : msg.content;
            systemMessage += sanitizePromptText(text) + '\n\n';
        } else {
            let textContent = '';
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        textContent += sanitizePromptText(part.text);
                    } else if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/')) {
                        const b64Data = part.image_url.url.split(',')[1];
                        if (b64Data) {
                            imageCounter++;
                            const mimePart = part.image_url.url.split(';')[0];
                            const ext = mimePart.includes('/') ? mimePart.split('/')[1] : 'png';
                            const imagePath = path.join(turnTempDir, `image_${imageCounter}.${ext}`);
                            fs.writeFileSync(imagePath, Buffer.from(b64Data, 'base64'));
                            textContent = '@' + imagePath + '\n' + textContent;
                        }
                    }
                }
            } else {
                textContent = sanitizePromptText(msg.content || '');
            }

            if (msg.role === 'user') {
                if (msg === lastUserMsg) {
                    conversationPrompt += `\n[LATEST INSTRUCTION]\nUSER: ${textContent}\n\n`;
                } else {
                    conversationPrompt += `USER: ${textContent}\n\n`;
                }
            } else if (msg.role === 'assistant') {
                let content = textContent;
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const tc of msg.tool_calls) {
                        const id = tc.id || 'unknown';
                        const name = tc.function?.name || tc.name || 'unknown';
                        const args = tc.function?.arguments || tc.arguments || '{}';
                        content += `\n⟬⟬tool_call:${id}:${name}:${args}⟭⟭`;
                    }
                }
                conversationPrompt += `ASSISTANT: ${content.trim()}\n\n`;
            } else if (msg.role === 'tool' || msg.role === 'function') {
                const callId = msg.tool_call_id || msg.name || 'unknown';
                conversationPrompt += `⟬⟬tool_result:${callId}:${textContent}⟭⟭\n\n`;
            }
        }
    }

    return {
        system: systemMessage.trim(),
        prompt: conversationPrompt.trim()
    };
}

// ─── System Messages ──────────────────────────────────────────────────────────

test('prompt_serial - system message goes to system, not prompt', () => {
    const { system, prompt } = serializeMessages([
        { role: 'system', content: 'You are a helpful assistant.' }
    ], os.tmpdir());

    assert.match(system, /You are a helpful assistant/);
    assert.equal(prompt, '');
});

test('prompt_serial - array system content is joined', () => {
    const { system } = serializeMessages([{
        role: 'system',
        content: [
            { type: 'text', text: 'Part one.' },
            { type: 'text', text: ' Part two.' }
        ]
    }], os.tmpdir());

    assert.match(system, /Part one\. Part two\./);
});

// ─── User Messages ────────────────────────────────────────────────────────────

test('prompt_serial - user message is prefixed with USER:', () => {
    const { prompt } = serializeMessages([
        { role: 'user', content: 'Hello there.' }
    ], os.tmpdir());

    assert.match(prompt, /USER: Hello there\./);
    assert.match(prompt, /\[LATEST INSTRUCTION\]/);
});

// ─── Assistant Messages ───────────────────────────────────────────────────────

test('prompt_serial - assistant message is prefixed with ASSISTANT:', () => {
    const { prompt } = serializeMessages([
        { role: 'assistant', content: 'I can help with that.' }
    ], os.tmpdir());

    assert.match(prompt, /^ASSISTANT: I can help with that\./);
});

test('prompt_serial - assistant tool_calls are narrated with ACTION format', () => {
    const { prompt } = serializeMessages([{
        role: 'assistant',
        content: '',
        tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' }
        }]
    }], os.tmpdir());

    assert.match(prompt, /⟬⟬tool_call:call_abc:get_weather:\{"city":"London"\}⟭⟭/);
});

test('prompt_serial - multiple tool_calls all narrated', () => {
    const { prompt } = serializeMessages([{
        role: 'assistant',
        content: '',
        tool_calls: [
            { function: { name: 'fn_a', arguments: '{}' } },
            { function: { name: 'fn_b', arguments: '{"x":1}' } }
        ]
    }], os.tmpdir());

    assert.match(prompt, /fn_a/);
    assert.match(prompt, /fn_b/);
});

// ─── Tool Result Messages ─────────────────────────────────────────────────────

test('prompt_serial - role:tool produces TOOL RESULT block with tool_call_id', () => {
    const { prompt } = serializeMessages([{
        role: 'tool',
        tool_call_id: 'call_abc',
        content: 'Sunny, 22°C'
    }], os.tmpdir());

    assert.match(prompt, /⟬⟬tool_result:call_abc:/);
    assert.match(prompt, /Sunny, 22°C/);
});

test('prompt_serial - role:function also produces TOOL RESULT block', () => {
    const { prompt } = serializeMessages([{
        role: 'function',
        name: 'get_weather',
        content: 'Rainy'
    }], os.tmpdir());

    assert.match(prompt, /⟬⟬tool_result:get_weather/);
});

// ─── Sanitization ─────────────────────────────────────────────────────────────

test('prompt_serial - lines starting with @ are escaped', () => {
    const { prompt } = serializeMessages([
        { role: 'user', content: '@some_file.txt please analyze this' }
    ], os.tmpdir());

    assert.match(prompt, /\\@some_file/);
});

test('prompt_serial - lines starting with ! are escaped', () => {
    const { prompt } = serializeMessages([
        { role: 'user', content: '!run_command do something' }
    ], os.tmpdir());

    assert.match(prompt, /\\!run_command/);
});

test('prompt_serial - lines NOT starting with @ or ! are not escaped', () => {
    const { prompt } = serializeMessages([
        { role: 'user', content: 'Normal message with email@test.com' }
    ], os.tmpdir());

    // Should not be escaped since @ is not at start of line
    assert.match(prompt, /email@test\.com/);
    assert.doesNotMatch(prompt, /\\email/);
});

// ─── Image Injection ──────────────────────────────────────────────────────────

test('prompt_serial - base64 image writes file and injects @path reference', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ionosphere-imgtest-'));
    // 1x1 red PNG in base64
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const { prompt } = serializeMessages([{
        role: 'user',
        content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } },
            { type: 'text', text: 'What is in this image?' }
        ]
    }], tmpDir);

    // Should inject @ file reference
    assert.match(prompt, /@.*image_1\.png/);
    assert.match(prompt, /What is in this image\?/);

    // Injected file should exist
    const files = fs.readdirSync(tmpDir);
    assert.ok(files.some(f => f.startsWith('image_1') && f.endsWith('.png')), 'Image file should be written');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Full conversation round-trip ─────────────────────────────────────────────

test('prompt_serial - full conversation serializes correctly in order', () => {
    const { prompt } = serializeMessages([
        { role: 'user', content: 'What time is it?' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'get_time', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'call_t1', content: '2026-02-21T21:00:00Z' },
        { role: 'user', content: 'Thanks!' }
    ], os.tmpdir());

    const parts = prompt.split('\n\n').filter(Boolean);
    assert.ok(parts[0].includes('USER: What time is it?'));
    assert.ok(parts[1].includes('⟬⟬tool_call:unknown:get_time:{}⟭⟭'));
    assert.ok(parts[2].includes('⟬⟬tool_result:call_t1'));
    assert.ok(parts[3].includes('USER: Thanks!'));
    assert.ok(parts[3].includes('[LATEST INSTRUCTION]'));
});
