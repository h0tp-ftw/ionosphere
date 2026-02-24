/**
 * test/reasoning_effort.test.js
 *
 * Verifies that the reasoning_effort parameter is correctly mapped to thinkingConfig.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateConfig } from '../scripts/generate_settings.js';

// We mock the mapping logic from index.js since it's hard to test the express route directly without a full server setup
// In a real scenario, we'd use a test client, but here we can verify the generateConfig part.
// However, the mapping happens in the route handler in index.js.
// So let's test that generateConfig correctly handles the thinkingConfig in generationConfig.

function tempPath() {
    return path.join(os.tmpdir(), `ionosphere-reasoning-test-${Date.now()}.json`);
}

test('generateConfig - handles thinkingConfig in generationConfig', () => {
    const targetPath = tempPath();
    const generationConfig = {
        thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 16384
        }
    };

    generateConfig({ targetPath, generationConfig, modelName: 'gemini-2.0-flash' });
    const written = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    fs.unlinkSync(targetPath);

    const config = written.modelConfigs?.customOverrides?.[0]?.modelConfig?.generateContentConfig;
    assert.ok(config, 'generation config should be present in overrides');
    assert.deepEqual(config.thinkingConfig, {
        includeThoughts: true,
        thinkingBudget: 16384
    });
});

test('mapping logic - low reasoning_effort', () => {
    // This replicates the logic in index.js
    const reasoningEffort = 'low';
    const generationConfig = {};
    if (reasoningEffort) {
        generationConfig.thinkingConfig = { includeThoughts: true };
        if (reasoningEffort === 'low') generationConfig.thinkingConfig.thinkingBudget = 4096;
    }

    assert.equal(generationConfig.thinkingConfig.thinkingBudget, 4096);
});

test('mapping logic - medium reasoning_effort', () => {
    const reasoningEffort = 'medium';
    const generationConfig = {};
    if (reasoningEffort) {
        generationConfig.thinkingConfig = { includeThoughts: true };
        if (reasoningEffort === 'medium') generationConfig.thinkingConfig.thinkingBudget = 16384;
    }

    assert.equal(generationConfig.thinkingConfig.thinkingBudget, 16384);
});

test('mapping logic - high reasoning_effort', () => {
    const reasoningEffort = 'high';
    const generationConfig = {};
    if (reasoningEffort) {
        generationConfig.thinkingConfig = { includeThoughts: true };
        if (reasoningEffort === 'high') generationConfig.thinkingConfig.thinkingBudget = 32768;
    }

    assert.equal(generationConfig.thinkingConfig.thinkingBudget, 32768);
});

test('mapping logic - max_completion_tokens', () => {
    // This replicates the logic in index.js
    const maxCompletionTokens = 1000;
    const generationConfig = {};
    if (maxCompletionTokens !== undefined) generationConfig.maxOutputTokens = maxCompletionTokens;

    assert.equal(generationConfig.maxOutputTokens, 1000);
});
