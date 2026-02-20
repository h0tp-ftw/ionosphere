# API Reference

## Base URL

```
http://localhost:3000
```

(Configurable via the `PORT` environment variable.)

---

## Endpoints

### `POST /v1/chat/completions`

Submit an OpenAI-compatible chat completion request to the Gemini CLI. Streams the response back as newline-delimited JSON Events (Server-Sent Events) or returns a single JSON object.

#### Request Format

**Content-Type**: `multipart/form-data`

> Plain `application/json` is also accepted for text-only prompts. Multipart is required when attaching files.

| Field | Type | Required | Description |
|---|---|---|---|
| `messages` | `Array` | ✅ | Array of OpenAI-format message objects (e.g. `[{"role": "user", "content": "..."}]`). The `system` role is supported and extracted automatically. |
| `stream` | `boolean` | ❌ | If `true`, streams Server-Sent Events (SSE). Otherwise returns a single JSON object. |
| `mcpServers` | `JSON Object` | ❌ | Dynamic MCP Server configuration to inject for this turn (passed as a top-level property or inside `extra_body` depending on the client). |
| `customSettings` | `JSON Object` | ❌ | Dynamic Gemini CLI settings (e.g. `modelConfigs`) to deeply merge for this turn. |

#### File Injection Mechanics

Since the API now exclusively accepts JSON `messages`, file ingestion (via `multipart/form-data`) has been deprecated. To attach files or URLs to a prompt, you must pass them as inline text references in your message content (e.g., `"Summarize this file: @/path/to/doc.pdf"`), and the orchestrator's isolated workspace engine will securely pipe it.

Lines starting with `@` or `!` in normal conversation are automatically prefixed with a `\` to prevent Gemini CLI from reading unintended host files.

#### Example: Basic Chat Request

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "system", "content": "You are a helpful physics teacher."},
      {"role": "user", "content": "Explain the theory of relativity in one paragraph."}
    ],
    "stream": true
  }'
```

#### Example: With MCP Servers (JSON)

You can spin up an isolated Gemini session with access to specific MCP servers by passing the `mcpServers` object in the JSON request. Ionosphere will dynamically inject this configuration into that turn's execution environment.

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Ask context7 about lsmcp"}],
    "stream": true,
    "mcpServers": {
      "context7": {
        "httpUrl": "https://mcp.context7.com/mcp",
        "headers": {
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }'
```

#### Example: With Custom Model Configs (JSON)

You can forcefully inject custom model hyperparameters (like `temperature: 0.0`) for a single request using the `customSettings` block to merge `modelConfigs` into the isolated workspace.

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Write a deterministic function."}],
    "customSettings": {
      "modelConfigs": {
        "customAliases": {
          "precise-mode": {
            "extends": "chat-base",
            "modelConfig": {
              "generateContentConfig": {
                "temperature": 0.0,
                "topP": 1.0
              }
            }
          }
        },
        "overrides": [
          {
            "match": { "model": "gemini-2.5-flash-lite" },
            "modelConfig": { "model": "precise-mode" }
          }
        ]
      }
    }
  }'
```

## Streaming Response Format

The response follows the standard OpenAI Server-Sent Events (SSE) format natively.

### Event Types

#### `data: {...}` — Chunk Delta

```json
data: {"id":"chatcmpl-c3d8cc87","object":"chat.completion.chunk","created":1740084337,"model":"gemini-cli","choices":[{"index":0,"delta":{"content":"The theory of relativity..."},"logprobs":null,"finish_reason":null}]}
```

Emitted incrementally as the model generates tokens.

#### `data: [DONE]` — Exact End of Stream

**This is the terminal event.** The HTTP response ends gracefully after this line.

#### `error` — Fatal orchestrator error

```json
data: {"error":{"message":"Fatal: CLI Auth Expired...","type":"error","code":"AUTH_EXPIRED"}}
```

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

The orchestrator will never forcibly close a connection due to inactivity.

### Client Disconnect Handling

If the client closes the connection mid-stream (crash, user cancel, network drop):

1. Express fires `req.on('close')`
2. The orchestrator calls `controller.cancelCurrentTurn()`
3. `SIGINT` is dispatched to the running CLI process
4. The CLI halts generation and emits `FatalCancellationError`

Since each prompt runs as a separate one-shot CLI process, there is no persistent state to lose.

---

## Health Check

### `GET /health`

Returns the current readiness state of the CLI subprocess.

```bash
curl http://localhost:3000/health
```

```json
{"status": "ok"}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | Always `"ok"` if the server is running |

---

## Session Routing

Ionosphere supports two session modes, configured via the `SESSION_MODE` environment variable:

### Stateless Mode *(default)*

Every prompt spawns a fresh Gemini CLI session. The full conversation history is sent as the prompt each time. No session tracking, no `--resume`, no state drift. This is the architecturally correct choice for OpenAI-compatible clients that already send the full `messages[]` array on every request.

### Stateful Mode (`SESSION_MODE=stateful`)

The `SessionRouter` automatically identifies which Gemini CLI session to resume using a Longest Common Prefix (LCP) walk across all known sessions. It then extracts only the new content (delta) and spawns `gemini --resume <sessionId> -p <delta>`. Clients do not need to be aware of this — send the full history as normal and the router will find the right session.

If no stored session matches (the conversations diverge), a new CLI session is created automatically.

---

## Error Responses

For non-streaming errors (before the response stream begins):

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error": "Missing 'prompt' in request payload"}` | No `prompt` field in request |
| `500` | `{"error": "...message..."}` | Unexpected orchestrator error |
