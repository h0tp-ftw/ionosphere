import test from 'node:test';
import assert from 'node:assert';
import { ContextDiffer } from '../src/ContextDiffer.js';

// ── Baseline: Pass-through before first round-trip ──────────────────────────

test('ContextDiffer - passes full payload before first round-trip', (t) => {
    const differ = new ContextDiffer();
    const payload = "Tell me a joke.";
    const delta = differ.extractDelta(payload);
    assert.strictEqual(delta, payload, "First payload must pass through unchanged");
    assert.strictEqual(differ.hasCompletedFirstTurn, false);
});

// ── Core case: stateless client appends new text at end of prior payload ─────
//
// This simulates the actual behaviour of apps like Roo Code or OpenClaw:
//   Turn 1 payload:  "User: Tell me a joke."
//   Turn 2 payload:  "User: Tell me a joke. <model response> User: Explain it."
//
// The new payload IS the old payload + model response + new user text.
// The LCP walk reaches the end of Turn 1's payload (perfect prefix), so
// splitPoint === last.length, and the delta is everything appended after it.

test('ContextDiffer - strips prior payload and returns only the delta', (t) => {
    const differ = new ContextDiffer();

    const turn1 = "User: Tell me a joke.";
    differ.extractDelta(turn1);   // Turn 1 out — no diff yet, stored as lastPayload
    differ.recordResponse();       // Turn 1 in — mark round-trip complete

    // Stateless client sends the full history + the new message
    const turn2 = "User: Tell me a joke.\nAssistant: Why did the chicken cross the road?\nUser: Explain the punchline.";
    const delta = differ.extractDelta(turn2);

    assert.strictEqual(
        delta,
        "Assistant: Why did the chicken cross the road?\nUser: Explain the punchline.",
        "Must strip the first turn and return only what was appended"
    );
});

// ── Edge case: identical payload (no new content) ────────────────────────────

test('ContextDiffer - returns empty string if payload has no new content', (t) => {
    const differ = new ContextDiffer();

    const turn1 = "Hello.";
    differ.extractDelta(turn1);
    differ.recordResponse();

    const delta = differ.extractDelta(turn1); // Exact same string
    assert.strictEqual(delta, "", "No new content should yield an empty delta");
});

// ── Edge case: context diverges mid-string (client rewrote a prior message) ──

test('ContextDiffer - returns tail from split point when payload diverges', (t) => {
    const differ = new ContextDiffer();

    differ.extractDelta("Hello world.");
    differ.recordResponse();

    // Client sends a modified history — "world" became "WORLD"
    const diverged = "Hello WORLD. New question?";
    const delta = differ.extractDelta(diverged);

    // LCP diverges at char 6 ('w' vs 'W')
    // delta = diverged.slice(6).trim() = "WORLD. New question?"
    assert.ok(delta.includes("WORLD"), "Delta must include content from the divergence point");
    assert.ok(delta.length > 0, "Diverged payload must produce non-empty delta");
});

// ── Reset clears all state ───────────────────────────────────────────────────

test('ContextDiffer - reset clears all state', (t) => {
    const differ = new ContextDiffer();

    differ.extractDelta("Something was said.");
    differ.recordResponse();

    differ.reset();

    assert.strictEqual(differ.lastPayload, '');
    assert.strictEqual(differ.hasCompletedFirstTurn, false);

    // After reset, next payload passes through unchanged
    const fresh = differ.extractDelta("New session prompt.");
    assert.strictEqual(fresh, "New session prompt.");
});
