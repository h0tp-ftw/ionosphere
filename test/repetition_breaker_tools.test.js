import test from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionBreaker } from '../src/RepetitionBreaker.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_HISTORY_FILE = path.join(__dirname, 'temp_history.txt');

test('RepetitionBreaker - checkToolRepeatLimit reads from history file', async (t) => {
    const breaker = new RepetitionBreaker();
    const historyData = 'hash1:tool1:{"arg":"val"}';
    fs.writeFileSync(TEMP_HISTORY_FILE, historyData);

    const proc = {
        extraEnv: {
            IONOSPHERE_HISTORY_TOOLS_PATH: TEMP_HISTORY_FILE
        }
    };

    const activeCallbacks = {};
    const result = breaker.checkToolRepeatLimit(
        proc,
        'tool1',
        { arg: 'val' },
        'hash1',
        null,
        activeCallbacks
    );

    assert.strictEqual(result, 'IGNORE', 'Should ignore historical tool call read from file');

    // Cleanup
    if (fs.existsSync(TEMP_HISTORY_FILE)) {
        fs.unlinkSync(TEMP_HISTORY_FILE);
    }
});

test('RepetitionBreaker - checkToolRepeatLimit handles missing history file gracefully', async (t) => {
    const breaker = new RepetitionBreaker();
    const NON_EXISTENT_FILE = path.join(__dirname, 'non_existent.txt');

    const proc = {
        extraEnv: {
            IONOSPHERE_HISTORY_TOOLS_PATH: NON_EXISTENT_FILE
        }
    };

    const result = breaker.checkToolRepeatLimit(
        proc,
        'tool1',
        { arg: 'val' },
        'hash1',
        null,
        {}
    );

    assert.strictEqual(result, false, 'Should not throw and return false when file is missing');
});
