# API Reference

## Base URL

```
http://localhost:3000
```

(Configurable via the `PORT` environment variable.)

---

## Endpoints

### `POST /v1/prompt`

Submit a prompt to the Gemini CLI. Streams the response back as newline-delimited JSON (NDJSON).

#### Request Format

**Content-Type**: `multipart/form-data`

> Plain `application/json` is also accepted for text-only prompts. Multipart is required when attaching files.

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | ✅ | The instruction or query for the agent |
| `files` | `File[]` | ❌ | One or more files to inject into the CLI context |

#### File Injection Mechanics

Files uploaded via the `files` field are streamed by `multer` into the orchestrator's `temp/` directory. The controller maps each file to the CLI's `@filepath` injection syntax and prepends it to the prompt before piping to stdin:

```
@/app/temp/image-uuid.png
@/app/temp/document-uuid.pdf
Your actual prompt text here.
```

All injected files are garbage-collected at the end of the turn via the `try/finally` GC block — regardless of whether the turn succeeded, timed out, or was cancelled.

#### Example: Text-only (JSON)

```bash
curl -X POST http://localhost:3000/v1/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain the theory of relativity in one paragraph."}'
```

#### Example: Text + File (Multipart)

```bash
curl -X POST http://localhost:3000/v1/prompt \
  -F "prompt=Summarize the contents of this document." \
  -F "files=@/path/to/document.pdf"
```

#### Example: Multiple Files

```bash
curl -X POST http://localhost:3000/v1/prompt \
  -F "prompt=Compare these two images." \
  -F "files=@image1.png" \
  -F "files=@image2.png"
```

---

## Streaming Response Format

The response is a chunked stream of newline-delimited JSON objects (`application/x-ndjson`). Each line is a self-contained JSON event.

### Event Types

#### `text` — Dialogue or reasoning output

```json
{"type": "text", "value": "The theory of relativity..."}
```

Emitted incrementally as the model generates tokens.

#### `toolCall` — MCP tool invocation

```json
{"type": "toolCall", "name": "web_browser", "args": {"action": "navigate", "params": {"url": "https://example.com"}}}
```

Emitted when the CLI dispatches a call to the FastMCP server.

#### `result` — Definitive turn boundary

```json
{"type": "result", "status": "success", "content": "..."}
```

```json
{"type": "result", "status": "error", "error": {"type": "FatalCancellationError", "message": "Operation cancelled."}}
```

**This is the terminal event.** The HTTP response ends after this line. Internally, this event also releases the Mutex and triggers the temp file GC.

#### `ping` — Heartbeat (keep-alive)

```json
{"type": "ping"}
```

Emitted every **15 seconds** while the CLI is busy. This prevents reverse proxies (NGINX, Cloudflare, Traefik) from treating a silent but active connection as idle and closing it. Clients should silently discard `ping` events.

#### `error` — Fatal orchestrator error

```json
{"type": "error", "error": {"code": "AUTH_EXPIRED", "message": "Fatal: CLI Auth Expired..."}}
```

Emitted if the orchestrator's stderr monitor detects authentication failure keywords. The server process exits after `AUTH_EXPIRED` — requires container restart or re-authentication.

---

## Connection Resilience

### Infinite Socket Timeout

Both the request and response sockets have their timeouts explicitly set to `0` (disabled):

```javascript
req.setTimeout(0);
res.setTimeout(0);
```

Agentic ReAct loops running tools like headless Playwright scraping can take minutes. The orchestrator will never forcibly close a connection due to inactivity.

### Client Disconnect Handling

If the client closes the connection mid-stream (crash, user cancel, network drop):

1. Express fires `req.on('close')`
2. The orchestrator calls `controller.cancelCurrentTurn()`
3. `SIGINT` is dispatched to the CLI process
4. The CLI halts generation, preserves its full context window, and emits `FatalCancellationError`
5. The Mutex releases; the orchestrator returns to `IDLE`

The CLI **does not die**. The next request from any client will resume in the same conversation context.

---

## Health Check

### `GET /health`

Returns the current readiness state of the CLI subprocess.

```bash
curl http://localhost:3000/health
```

```json
{"status": "ok", "ready": true}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | Always `"ok"` if the server is running |
| `ready` | `boolean` | `true` if the CLI subprocess has initialized and is ready to accept input |

---

## Context Diffing (Stateless Client Compatibility)

Ionosphere is designed to work with stateless AI frontends (Roo Code, OpenClaw, etc.) that send the full conversation history on every request.

The `ContextDiffer` middleware automatically strips redundant prior context using a Longest Common Prefix (LCP) walk before the payload reaches the CLI. Clients do not need to be aware of this — send the full history as normal and only the new delta will reach the stateful CLI process.

This is active **only after the first complete round-trip** (one prompt + one `result` response). The first turn always passes through unchanged.

---

## Error Responses

For non-streaming errors (before the response stream begins):

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error": "Missing 'prompt' in request payload"}` | No `prompt` field in request |
| `500` | `{"error": "...message..."}` | Unexpected orchestrator error |
