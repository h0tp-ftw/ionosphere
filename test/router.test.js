import test from 'node:test';
import assert from 'node:assert';
import { SessionRouter } from '../src/SessionRouter.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use a temp path for test persistence to avoid clobbering real data
function makeTempPersistPath() {
    return path.join(os.tmpdir(), `session-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ── Empty store: new session ─────────────────────────────────────────────────

test('SessionRouter - routes to new session when no sessions exist', (t) => {
    const router = new SessionRouter(makeTempPersistPath());
    const result = router.route("Hello world");

    assert.strictEqual(result.sessionId, null);
    assert.strictEqual(result.delta, "Hello world");
    assert.strictEqual(result.isNew, true);

    router.reset();
});

// ── CONTINUATION: stored session is a prefix of incoming ─────────────────────

test('SessionRouter - CONTINUATION: resumes session and extracts delta', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    // Simulate: first turn was "User: Hello."
    router.registerSession('session-abc', "User: Hello.");

    // Client sends the full history + new message
    const incoming = "User: Hello.\nAssistant: Hi there!\nUser: How are you?";
    const result = router.route(incoming);

    assert.strictEqual(result.sessionId, 'session-abc');
    assert.strictEqual(result.isNew, false);
    assert.strictEqual(result.delta, "Assistant: Hi there!\nUser: How are you?");

    router.reset();
});

// ── IDENTICAL: exact same payload ────────────────────────────────────────────

test('SessionRouter - IDENTICAL: returns empty delta for duplicate payload', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    router.registerSession('session-abc', "User: Hello.");

    const result = router.route("User: Hello.");

    assert.strictEqual(result.sessionId, 'session-abc');
    assert.strictEqual(result.isNew, false);
    assert.strictEqual(result.delta, '');

    router.reset();
});

// ── SUBSET: incoming is shorter than stored ──────────────────────────────────

test('SessionRouter - SUBSET: creates new session when incoming is shorter than stored', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    // S has a full multi-turn conversation
    router.registerSession('session-abc', "User: Hello.\nAssistant: Hi there!\nUser: How are you?");

    // Client sends just the beginning — they may be branching from an earlier point
    const result = router.route("User: Hello.");

    // Must NOT resume S — the client's next message could diverge
    assert.strictEqual(result.sessionId, null);
    assert.strictEqual(result.isNew, true);
    assert.strictEqual(result.delta, "User: Hello.");

    router.reset();
});

// ── DIVERGENT: both payloads have different content after split point ─────────

test('SessionRouter - DIVERGENT: creates new session when payloads differ', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    router.registerSession('session-abc', "User: Hello World.");

    // Client sends a different conversation
    const result = router.route("User: Hello Earth.");

    assert.strictEqual(result.sessionId, null);
    assert.strictEqual(result.isNew, true);
    assert.strictEqual(result.delta, "User: Hello Earth.");

    router.reset();
});

// ── Multi-session: picks the best (longest LCP) match ────────────────────────

test('SessionRouter - picks the session with the longest LCP match', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    router.registerSession('session-short', "Hello");
    router.registerSession('session-long', "Hello World");

    // Incoming extends "Hello World" further
    const result = router.route("Hello World!!!");

    assert.strictEqual(result.sessionId, 'session-long');
    assert.strictEqual(result.isNew, false);
    assert.strictEqual(result.delta, '!!!');

    router.reset();
});

// ── Multi-session: skips divergent, picks continuation ───────────────────────

test('SessionRouter - skips divergent sessions and picks the continuation match', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    // This session diverges from the incoming payload
    router.registerSession('session-divergent', "Hello Earth, how are you?");
    // This session is a prefix of the incoming payload
    router.registerSession('session-match', "Hello World");

    const result = router.route("Hello World, nice weather!");

    assert.strictEqual(result.sessionId, 'session-match');
    assert.strictEqual(result.isNew, false);
    assert.strictEqual(result.delta, ', nice weather!');

    router.reset();
});

// ── Persistence: survives router recreation ──────────────────────────────────

test('SessionRouter - persists sessions to disk and reloads', (t) => {
    const persistPath = makeTempPersistPath();

    const router1 = new SessionRouter(persistPath);
    router1.registerSession('session-abc', "Hello World");
    router1.registerSession('session-def', "Goodbye World");

    // Create a new router pointing to the same persistence file
    const router2 = new SessionRouter(persistPath);

    assert.strictEqual(router2.stmtCount.get().count, 2);
    assert.strictEqual(router2.db.prepare("SELECT payload FROM sessions WHERE id = 'session-abc'").get().payload, "Hello World");
    assert.strictEqual(router2.db.prepare("SELECT payload FROM sessions WHERE id = 'session-def'").get().payload, "Goodbye World");

    // Route should work on the reloaded router
    const result = router2.route("Hello World, new turn.");
    assert.strictEqual(result.sessionId, 'session-abc');
    assert.strictEqual(result.delta, ', new turn.');

    router1.reset();
    router2.reset();

    // Clean up persistence file
    try { fs.unlinkSync(persistPath); } catch (e) { /* ignore */ }
});

// ── Reset clears all state ───────────────────────────────────────────────────

test('SessionRouter - reset clears all sessions', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    router.registerSession('session-abc', "Hello");
    assert.strictEqual(router.stmtCount.get().count, 1);

    router.reset();
    assert.strictEqual(router.stmtCount.get().count, 0);

    // After reset, everything routes as new
    const result = router.route("Hello");
    assert.strictEqual(result.isNew, true);
});

// ── recordTurn updates the stored payload ────────────────────────────────────

test('SessionRouter - recordTurn updates stored payload for future routing', (t) => {
    const router = new SessionRouter(makeTempPersistPath());

    router.registerSession('session-abc', "Hello");

    // Simulate: first turn completed, record the full cumulative payload
    router.recordTurn('session-abc', "Hello World");

    // Now route a continuation of the updated payload
    const result = router.route("Hello World!!!");
    assert.strictEqual(result.sessionId, 'session-abc');
    assert.strictEqual(result.delta, '!!!');

    router.reset();
});
