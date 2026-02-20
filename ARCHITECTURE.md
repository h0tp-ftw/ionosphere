# Architecture

## Overview

Ionosphere is a session-aware API bridge for the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli). It uses a **Longest Common Prefix (LCP)** algorithm to route incoming prompts to the correct Gemini CLI session — or create a new one when conversations diverge.

Instead of maintaining a single persistent CLI process, Ionosphere spawns a **one-shot CLI process per prompt** with `gemini --resume <sessionId>`. The Gemini CLI natively persists sessions to disk, so context survives both bridge and CLI restarts.

```
HTTP Client (Roo Code / OpenClaw / curl)
        |
        | POST /v1/prompt  (multipart/form-data)
        v
┌─────────────────────────────────────────────────────┐
│              Express HTTP Server (index.js)          │
│  - Infinite socket timeout                          │
│  - 15s heartbeat ping                               │
│  - Per-request event listeners                      │
│  - req.on('close') → cancelCurrentTurn()            │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│           SessionRouter (LCP Multi-Session)          │
│  Routes payload to best-matching CLI session.       │
│  Persists session map to disk (sessions.json).      │
│  Decision: CONTINUATION / IDENTICAL / NEW           │
└───────────────────┬─────────────────────────────────┘
                    │  { sessionId, delta, isNew }
                    ▼
┌─────────────────────────────────────────────────────┐
│       GeminiController (One-Shot Spawner)            │
│                                                     │
│  - Spawns: gemini --resume <id> -p @file -o json    │
│  - New sessions: gemini -p @file -o stream-json     │
│  - 5-minute timeout per prompt                      │
│  - Discovers session IDs via --list-sessions        │
│  - JsonlAccumulator buffers OS pipe fragments       │
└───────────────────┬─────────────────────────────────┘
                    │ stdout (stream-json)
                    ▼
              Response streamed
              back to HTTP client
```

---

## The LCP Session Router

Stateless AI clients (Roo Code, OpenClaw, OpenAI-compatible frontends) send the **entire conversation history** in every HTTP request. Ionosphere must determine **which CLI session** to resume with just the new content (the "delta").

### Algorithm

Given an incoming payload `P` and a stored session `S` with cumulative payload `S.payload`:

1. Walk character-by-character comparing `P[i]` to `S.payload[i]`
2. Stop at the first mismatch at position `n`
3. Inspect what remains at position `n`:

| `P[n]` exists? | `S[n]` exists? | Verdict |
|---|---|---|
| Yes | No | **CONTINUATION** — `S` is a prefix of `P`. Resume session S, delta = `P[n:]` |
| No | Yes | **SUBSET** — `P` is shorter than `S`. Create new session (client may branch) |
| No | No | **IDENTICAL** — exact match, no-op resume |
| Yes | Yes | **DIVERGENT** — different conversation, skip this session |

### Multi-Session Selection

When multiple sessions exist, the router picks the **non-divergent, non-subset candidate with the longest LCP**. If no valid candidates remain, a new session is created.

### Why SUBSET Creates a New Session

Consider:
```
S (stored):  "What is 2+2?" → "4" → "And what is that squared?" → "16"
P (incoming): "What is 2+2?" → "4"
```

The client sent only the first two turns. Their **next** message could be "And what is that squared?" (matching S) or "What about 3+3?" (diverging). Since we can't predict the future, we must not resume S — the CLI would carry extra context the client didn't ask for.

### Complexity

- **Time:** O(K × M) where K = stored sessions, M = payload length
- **Accuracy:** 100% — pure character comparison, no hashing
- Practically, K is small (tens of sessions) and string comparison is SIMD-optimized in V8

---

## One-Shot CLI Model

Each prompt spawns a fresh CLI process:

```bash
# Resume an existing session:
gemini --resume <sessionId> -p @prompt.txt -o stream-json

# Start a new session:
gemini -p @prompt.txt -o stream-json
```

**Why one-shot instead of persistent REPL?**

| Aspect | Persistent REPL | One-Shot |
|---|---|---|
| Multi-session support | ❌ One process = one session | ✅ Any session per prompt |
| Context persistence | ❌ Lost on crash/restart | ✅ CLI saves to disk natively |
| Cold-start overhead | None | ~1-2s per prompt |
| Process management | Complex (death detection, respawn) | Simple (spawn and wait) |

The trade-off is acceptable: the ~1-2s cold-start is negligible compared to the 5-30s LLM generation time.

---

## Session Discovery

When a **new** conversation is created (no LCP match), the bridge must learn the session ID that the CLI assigned. After the one-shot process exits, the controller calls:

```bash
gemini --list-sessions
```

It then parses the output for the most recent UUID and registers it in the `SessionRouter` for future routing.

---

## The JSONL Accumulator

The OS pipe between Node.js and the CLI does not guarantee that a complete JSON object arrives in a single `data` event. A single object might be split across multiple reads.

`JsonlAccumulator` buffers all incoming chunks as a string. On every `\n` character it attempts to parse the preceding text as JSON. Only valid, complete JSON objects are emitted as `line` events.

---

## Signal Physics — SIGINT Survival

When an HTTP client drops mid-stream, Ionosphere dispatches `SIGINT` to the running CLI process (not `SIGTERM`). This allows the CLI to halt generation gracefully and emit a `FatalCancellationError` result, which signals the controller to clean up without losing the process.

---

## Session Persistence

The `SessionRouter` serializes its session map (`sessionId → payload`) to `temp/sessions.json`. This means:

1. Bridge restarts reload the session map from disk
2. The CLI's own session storage (`~/.gemini/sessions/`) persists conversation history
3. Both must agree for a session to be resumable

---

## Docker Build

The deployment is a lightweight, single-stage `node:22-slim` container.

It installs standard Node dependencies, then installs the `@google/gemini-cli` globally so the binary is baked into the image at build time.

The `GEMINI_CLI_TAG` build arg (default: `latest`) controls which release channel of the CLI is installed:

```bash
docker-compose build --build-arg GEMINI_CLI_TAG=preview
```

The container's `CMD` generates `settings.json` at startup then launches the orchestrator:

```dockerfile
CMD ["sh", "-c", "node scripts/generate_settings.js && node src/index.js"]
```
