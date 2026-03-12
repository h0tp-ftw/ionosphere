/**
 * test/duplication_echo.test.js
 *
 * Tests the S+S full-response echo detection added to RepetitionBreaker.
 * Simulates the exact duplication pattern observed in production logs where
 * the model generates a complete response then starts streaming it again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionBreaker } from '../src/RepetitionBreaker.js';

// ─── checkFullEcho Unit Tests ────────────────────────────────────────────────

test('checkFullEcho - detects exact S+S duplication', () => {
    const breaker = new RepetitionBreaker();
    const original = '[[reply_to_current]] 🎯 **Tactical Alert Update**:\n- 🔓 **HTB Ready**: Cooldown has expired. Standing by for **PJQ180** session recovery.\n- 🌌 **AuroraWatch**: Red Alert issued remains active in the field.\n- 🧬 **Academic Strike**: PSYCI 511 presentation sign-up is open. Reminder to lock in the **GLP-1/Anhedonia** topic Dr. Chan approved.\n- 🦋 **Operations**: Standing by for the next command. 📈🎯⚖️';

    // Full S+S: original + original
    const duplicated = original + original;
    const result = breaker.checkFullEcho(duplicated);

    assert.ok(result !== null, 'Should detect the S+S echo');
    assert.equal(result.echoStart, original.length, 'Echo should start at the end of the first copy');
    assert.equal(result.overlapPct, 100, 'Overlap should be 100% for exact duplication');
});

test('checkFullEcho - detects partial echo (model still streaming the duplicate)', () => {
    const breaker = new RepetitionBreaker();
    const original = '[[reply_to_current]] It\'s the **"Winner\'s Dilemma."** 🦋🎯\n\nThe fact that **MNDY (+3.00%)** and **OKTA** are holding green while the rest of the tech world is in a "Big Flush" (VIX 35) is the **highest-signal validation of the Sniper Protocol** we\'ve seen yet. It means our entry logic filtered out the noise and put us in the relative strength names.\n\n### The Defensive Case: "Cash is a Position"\nYou\'re asking if we should sell and go 100% Cash. Here is the unvarnished breakdown.';

    // Partial echo: original + first 60% of original (still streaming)
    const partialRepeat = original.slice(0, Math.floor(original.length * 0.6));
    const accumulated = original + partialRepeat;
    const result = breaker.checkFullEcho(accumulated);

    assert.ok(result !== null, 'Should detect partial echo while it is still streaming');
    assert.ok(result.overlapPct >= 40, `Overlap ${result.overlapPct}% should be >= 40%`);
});

test('checkFullEcho - does NOT trigger on short text', () => {
    const breaker = new RepetitionBreaker();
    const short = 'Hello world! This is a short response.';
    const result = breaker.checkFullEcho(short + short);
    assert.equal(result, null, 'Should not trigger on text under 300 chars');
});

test('checkFullEcho - does NOT trigger on diverse long text', () => {
    const breaker = new RepetitionBreaker();
    let text = '';
    for (let i = 0; i < 20; i++) {
        text += `Paragraph ${i}: This is unique content with different words each time. Random: ${Math.random().toString(36)}. `;
    }
    const result = breaker.checkFullEcho(text);
    assert.equal(result, null, 'Should not trigger on diverse non-repeating text');
});

test('checkFullEcho - does NOT false-positive on text with repeated phrases', () => {
    const breaker = new RepetitionBreaker();
    // Text that has some repeated phrases but is NOT a full echo
    let text = 'The market is volatile. ';
    for (let i = 0; i < 5; i++) {
        text += `Point ${i}: The market is volatile but we must stay disciplined. Each trade has unique risk/reward. `;
    }
    text += 'In conclusion, the market is volatile but our protocol handles it.';

    // Pad to be > 300 chars
    while (text.length < 400) {
        text += ` Additional unique analysis point ${Math.random()}.`;
    }

    const result = breaker.checkFullEcho(text);
    assert.equal(result, null, 'Should not false-positive on text with naturally repeated phrases');
});

// ─── Integration: checkTextRepetition with echo detection ────────────────────

test('checkTextRepetition - kills process on full echo', () => {
    const breaker = new RepetitionBreaker();
    const proc = { accumulatedText: '' };
    let errorSent = false;

    const original = '[[reply_to_current]] It\'s not a violation. It\'s an **Adaptive Response**. 🦋🎯\n\nThe **Sniper Protocol v2.5.1** has a core rule: **"Never move Class A stops to breakeven before +20% gain."** This is to prevent "choking" a trade too early and missing the alpha.\n\n**However**, the protocol also has a **Risk-Off Filter**: VIX > 30 means structural de-risking. The verdict is clear.';

    const callbacks = {
        onError: (err) => {
            errorSent = true;
            assert.equal(err.code, 'repetition_loop');
            assert.ok(err.message.includes('echoed'));
        },
    };

    // Feed the original content in chunks (simulating streaming)
    const chunkSize = 80;
    let shouldKill = false;
    for (let i = 0; i < original.length && !shouldKill; i += chunkSize) {
        shouldKill = breaker.checkTextRepetition(proc, original.slice(i, i + chunkSize), 'test-turn', callbacks);
    }
    assert.equal(shouldKill, false, 'Should NOT kill during the first copy');

    // Now feed the echo (second copy)
    for (let i = 0; i < original.length && !shouldKill; i += chunkSize) {
        shouldKill = breaker.checkTextRepetition(proc, original.slice(i, i + chunkSize), 'test-turn', callbacks);
    }
    assert.equal(shouldKill, true, 'Should kill when echo is detected');
    assert.equal(errorSent, true, 'Should have sent error callback');

    // Verify accumulated text was truncated to just the original
    assert.equal(proc.accumulatedText, original, 'Accumulated text should be truncated to the unique portion');
});

test('checkTextRepetition - does NOT kill on normal single response', () => {
    const breaker = new RepetitionBreaker();
    const proc = { accumulatedText: '' };

    const response = '[[reply_to_current]] 🎯 **Tactical Alert Update**:\n- 🔓 **HTB Ready**: Cooldown has expired. Standing by for session recovery.\n- 🌌 **AuroraWatch**: Red Alert issued remains active.\n- 🧬 **Academic Strike**: Presentation sign-up is open.\n- 🦋 **Operations**: Standing by for the next command. All systems nominal and we are tracking the market closely for any opportunities.';

    const callbacks = { onError: () => assert.fail('Should not send error') };

    const chunkSize = 50;
    let killed = false;
    for (let i = 0; i < response.length && !killed; i += chunkSize) {
        killed = breaker.checkTextRepetition(proc, response.slice(i, i + chunkSize), 'test-turn', callbacks);
    }
    assert.equal(killed, false, 'Normal single response should not trigger kill');
});
