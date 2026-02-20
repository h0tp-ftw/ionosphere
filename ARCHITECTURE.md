# Architecture

## Overview

Ionosphere is built around a fundamental insight: the Gemini CLI in `--headless --output-format stream-json` mode is a **stateful, persistent process**. Every prompt fed to it over stdin is processed in the context of all prior conversation history — without the token overhead of embedding that history in every API call.

The orchestrator's job is to act as a clean, resilient relay between HTTP-based clients and this stateful CLI subprocess.

```
HTTP Client (Roo Code / OpenClaw / curl)
        |
        | POST /v1/prompt  (multipart/form-data)
        v
┌─────────────────────────────────────────────────────┐
│              Express HTTP Server (index.js)          │
│  - Infinite socket timeout                          │
│  - 15s heartbeat ping                               │
│  - req.on('close') → cancelCurrentTurn()            │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│           ContextDiffer (LCP Stripper)               │
│  Strips redundant history from stateless clients.   │
│  Only the novel delta reaches the CLI.              │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│         GeminiController (State Machine)             │
│                                                     │
│  State: IDLE → PROCESSING → CANCELLING → IDLE       │
│                                                     │
│  - Mutex Queue (Promise chain)                      │
│  - Writes delta to temp file → pipes @path to stdin │
│  - JsonlAccumulator buffers OS pipe fragments       │
│  - Releases Mutex on {"type":"result"}              │
│  - try/finally GC: deletes temp files unconditionally│
└───────────────────┬─────────────────────────────────┘
                    │ stdin/stdout (pipes)
                    ▼
┌─────────────────────────────────────────────────────┐
│        gemini --headless --output-format stream-json │
│                                                     │
│  Maintains full conversation context in memory.     │
│  Connects to Python MCP server over stdio.          │
└───────────────┬─────────────────────────────────────┘
                │  stdio (MCP protocol)
                ▼
┌─────────────────────────────────────────────────────┐
│         Python FastMCP Server (server.py)            │
│                                                     │
│  Tools:                                             │
│  - web_browser   (Playwright headless Chromium)     │
│  - filesystem_manager (read/write/list/search)      │
└─────────────────────────────────────────────────────┘
```

---

## The State Machine

`GeminiController` tracks three states:

| State | Meaning |
|---|---|
| `IDLE` | No active prompt. Mutex is unlocked. Ready for input. |
| `PROCESSING` | Prompt written to CLI stdin. Mutex locked. Streaming response. |
| `CANCELLING` | `SIGINT` dispatched. Waiting for CLI to emit `FatalCancellationError`. |

The state machine prevents double-firing and race conditions when a client disconnects mid-generation.

---

## The Turn Boundary — Why `{"type": "result"}` Only

Early orchestrators used textual shell prompt detection (e.g., waiting for `> ` on stdout) to know when the CLI was ready for the next input. This is brittle and fails completely in `--output-format stream-json` mode, where no such prompt is emitted.

Ionosphere defines a turn boundary exclusively by the JSON payload:

```json
// Successful turn
{"type": "result", "status": "success", ...}

// Interrupted turn (SIGINT)
{"type": "result", "status": "error", "error": {"type": "FatalCancellationError"}}
```

**Only** when this object is parsed does the orchestrator:
1. Call `currentTurnDeferred.resolve()` → releasing the Mutex
2. Execute the `try/finally` GC block → deleting all temp files for this turn

This guarantees the CLI has fully flushed its internal state before the next prompt is enqueued.

---

## Signal Physics — SIGINT Survival

When an HTTP client drops mid-stream (e.g., the frontend crashes, network drops, or the user cancels), naive orchestrators call `process.kill()` (SIGTERM), which:
- Immediately destroys the CLI subprocess
- Wipes the entire conversation context window
- Forces an expensive cold-start for the next request

Ionosphere instead:

1. `req.on('close')` fires on the Express server
2. `controller.cancelCurrentTurn()` is called
3. State transitions to `CANCELLING`
4. `geminiProcess.kill('SIGINT')` is dispatched
5. The CLI traps `SIGINT`, halts generation, **preserves all memory**, and emits `FatalCancellationError`
6. The Mutex releases; state returns to `IDLE`

The CLI subprocess never dies. Context is never lost.

---

## The Mutex Queue

`GeminiController.sendPrompt()` chains all prompts onto a single `Promise` chain (`this.promptQueue`). Each turn:

```
promptQueue.then(async () => {
    state = PROCESSING
    try {
        await new Promise((resolve, reject) => {
            // write to stdin, set 5-min timeout
        });
        // resolved only by {"type":"result"}
    } finally {
        // GC: delete all temp files for this turn
        state = IDLE
    }
})
```

**Why `try/finally` for GC?** If the CLI crashes, times out, or receives SIGINT, the Promise rejects. Without `finally`, temp files would accumulate indefinitely on disk. The `finally` block runs unconditionally — whether the turn succeeded, timed out, or was cancelled.

The 5-minute Mutex Death Timer acts as an absolute backstop against permanent deadlocks.

---

## The JSONL Accumulator

The OS pipe between Node.js and the CLI does not guarantee that a complete JSON object arrives in a single `data` event. A single object might be split across 2, 3, or 10 reads.

`JsonlAccumulator` buffers all incoming chunks as a string. On every `\n` character it attempts to parse the preceding text as JSON. Only valid, complete JSON objects are emitted as `line` events. Incomplete fragments stay in the buffer until the rest arrives.

---

## The Context Differ — LCP Stripper

Stateless AI clients (Roo Code, OpenClaw, OpenAI-compatible frontends) must send the **entire conversation history** in every HTTP request — because from their perspective, the backend is stateless.

The Gemini CLI is NOT stateless. If the full history is piped to it every turn, it treats the prior conversation as a brand new user input, causing catastrophic hallucination and context duplication.

`ContextDiffer` solves this with a **Longest Common Prefix (LCP)** walk:

1. After the first round-trip completes, `lastPayload` stores the full previous request.
2. On each new request, walk character-by-character comparing `lastPayload[i]` vs `newPayload[i]`.
3. Stop at the first mismatch at index `n`.
4. If no mismatch occurs (pure extension — the common case): split at `lastPayload.length`.
5. `delta = newPayload.slice(splitPoint).trim()` — this is the only new content.
6. **Only the delta is piped to the CLI.**

| Case | Outcome |
|---|---|
| Pure extension (new message appended) | Delta = only the new user message |
| No new content (duplicate send) | Delta = `""` → mutex releases immediately, CLI not touched |
| Mid-string divergence (client rewrote history) | Delta = content from the split point |
| First turn (no prior baseline) | Full payload passes through unchanged |

---

## The MCP Bridge

The CLI's tool execution is handled over **stdio**, not HTTP. When `settings.json` configures `mcpServers.ionosphere`, the CLI automatically spawns:

```
python -m mcp_server.server
```

...and communicates with it over the MCP protocol via stdin/stdout pipes. No local port is opened. No network traffic is generated for tool calls.

### `web_browser` Tool

Manages a singleton headless Chromium instance via Playwright. The browser is lazy-initialized on first tool call and shared across all subsequent calls within the session.

| Action | Parameters |
|---|---|
| `navigate` | `url` |
| `get_text` | *(none)* — returns `document.body.innerText` |
| `click` | `selector` |
| `fill` | `selector`, `value` |
| `evaluate` | `script` — arbitrary JS, returns result |

### `filesystem_manager` Tool

Direct local filesystem operations using Python's `pathlib`.

| Action | Parameters |
|---|---|
| `read_file` | `path` |
| `write_file` | `path`, `content` |
| `list_directory` | `path` |
| `search_files` | `path`, `query` (filename substring match) |
| `make_directory` | `path` |
| `delete_path` | `path` |

---

## Multi-Stage Docker Build

**Stage 1 (`mcp`)**: Based on `mcr.microsoft.com/playwright/python:v1.44.0-jammy`. Installs Python MCP dependencies and Playwright Chromium with all OS-level browser dependencies pre-baked.

**Stage 2 (`app`)**: Based on `node:22-slim`. Copies browser libs from Stage 1, installs Python 3, copies Python packages, installs Node dependencies, then installs `@google/gemini-cli` globally.

The `GEMINI_CLI_TAG` build arg (default: `latest`) controls which release channel of the CLI is installed:

```bash
docker-compose build --build-arg GEMINI_CLI_TAG=preview
```

The container's `CMD` generates `settings.json` at startup then launches the orchestrator:

```dockerfile
CMD ["sh", "-c", "node scripts/generate_settings.js && node src/index.js"]
```

This ensures settings are always regenerated from environment variables at container start, not baked into the image layer.
