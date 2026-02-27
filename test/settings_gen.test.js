/**
 * test/settings_gen.test.js
 *
 * Unit tests for generateConfig — the per-turn settings.json generator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateConfig } from '../scripts/generate_settings.js';

function tempPath() {
    return path.join(os.tmpdir(), `ionosphere-settings-test-${Date.now()}.json`);
}

function generate(options = {}) {
    const targetPath = tempPath();
    const config = generateConfig({ targetPath, ...options });
    const written = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    fs.unlinkSync(targetPath);
    return { config, written };
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

test('generateConfig - produces valid JSON output', () => {
    const { written } = generate();
    assert.ok(typeof written === 'object');
    assert.ok(!Array.isArray(written));
});

test('generateConfig - telemetry is disabled by default', () => {
    const { written } = generate();
    assert.equal(written.telemetry?.enabled, false);
});

test('generateConfig - sets maxSessionTurns to 50 (default)', () => {
    const { written } = generate();
    assert.equal(written.model?.maxSessionTurns, 50);

});

test('generateConfig - sets compressionThreshold to 0.7 (default)', () => {
    const { written } = generate();
    assert.equal(written.model?.compressionThreshold, 0.7);

});

test('generateConfig - builtin tools are allowed by default', () => {
    const savedEnv = process.env.GEMINI_DISABLE_TOOLS;
    delete process.env.GEMINI_DISABLE_TOOLS; // let default behavior apply
    const { written } = generate();
    const excluded = written.tools?.exclude;
    assert.ok(excluded === undefined || excluded.length === 0, 'builtin tools should not be excluded by default');
    if (savedEnv !== undefined) process.env.GEMINI_DISABLE_TOOLS = savedEnv;
});

// ─── Model Routing ────────────────────────────────────────────────────────────

test('generateConfig - modelName overrides the model name', () => {
    const { written } = generate({ modelName: 'gemini-2.5-pro' });
    assert.equal(written.model?.name, 'gemini-2.5-pro');
});

test('generateConfig - falls back to GEMINI_MODEL env var if no modelName arg', () => {
    process.env.GEMINI_MODEL = 'gemini-test-model';
    const { written } = generate();
    assert.equal(written.model?.name, 'gemini-test-model');
    delete process.env.GEMINI_MODEL;
});

// ─── MCP Servers ─────────────────────────────────────────────────────────────

test('generateConfig - injects mcpServers when provided', () => {
    const mcpServers = {
        'ionosphere-tool-bridge': {
            command: 'node',
            args: ['/some/path/index.js'],
            env: { TOOL_BRIDGE_IPC: '/tmp/test.sock' }
        }
    };
    const { written } = generate({ mcpServers });
    assert.ok(written.mcpServers?.['ionosphere-tool-bridge']);
    assert.equal(written.mcpServers['ionosphere-tool-bridge'].command, 'node');
});

test('generateConfig - no mcpServers key when not provided', () => {
    const { written } = generate();
    assert.equal(written.mcpServers, undefined);
});

// ─── Custom Settings Deep Merge ───────────────────────────────────────────────

test('generateConfig - customSettings merges without overwriting base fields', () => {
    const customSettings = {
        model: { someExtraField: 'extra' }
    };
    const { written } = generate({ customSettings, modelName: 'gemini-test' });
    // Base field preserved
    assert.equal(written.model?.name, 'gemini-test');
    assert.equal(written.model?.maxSessionTurns, 50);
    // Custom field added
    assert.equal(written.model?.someExtraField, 'extra');
});

test('generateConfig - customSettings can add modelConfigs for generation params', () => {
    const customSettings = {
        modelConfigs: {
            customAliases: {
                'request-override': {
                    extends: 'gemini-2.5-flash',
                    modelConfig: {
                        generateContentConfig: { temperature: 0.5, maxOutputTokens: 100 }
                    }
                }
            },
            overrides: [{ match: { model: '*' }, modelConfig: { model: 'request-override' } }]
        }
    };
    const { written } = generate({ customSettings });
    const alias = written.modelConfigs?.customAliases?.['request-override'];
    assert.ok(alias, 'custom alias should be present');
    assert.equal(alias.modelConfig?.generateContentConfig?.temperature, 0.5);
});
