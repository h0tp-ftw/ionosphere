# Ionosphere Architecture

Ionosphere is a stateless HTTP bridge that translates OpenAI-compatible API requests into Gemini CLI invocations using native CLI features (JSONL streaming, MCP servers) and returns the results as OpenAI-format SSE streams. Every component lives in a single Node.js process — no persistent AI state is stored server-side.

---

## System Overview

```mermaid
flowchart TD
    Client["OpenAI-compatible Client\n(Roo Code / opencode / SDK)"]
    Bridge["Ionosphere Bridge\n(src/index.js — Express HTTP)"]
    Settings["settings.json\n(per-turn temp dir)"]
    CLI["Gemini CLI\n(node process)"]
    ToolBridge["ToolBridge\n(MCP stdio server)"]
    IPC["IPC Socket\n(named pipe / Unix socket)"]
    UpstreamMCP["Upstream MCP Servers\n(Context7, GitHub, etc.)"]

    Client -->|"POST /v1/chat/completions"| Bridge
    Bridge -->|"generateConfig()"| Settings
    Bridge -->|"spawns with --settings"| CLI
    CLI -->|"JSONL stream-json on stdout"| Bridge
    Bridge -->|"SSE delta chunks"| Client

    CLI <-->|"MCP stdio protocol"| ToolBridge
    ToolBridge <-->|"tool_call / tool_result"| IPC
    IPC <-->|"managed by"| Bridge
    Bridge -->|"SSE delta.tool_calls"| Client
    Client -->|"POST role:tool result"| Bridge

    ToolBridge -.->|"aggregates tools from"| UpstreamMCP
```

---

## Request Lifecycle (Single Turn)

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Bridge (index.js)
    participant S as settings.json
    participant TB as ToolBridge
    participant CLI as Gemini CLI

    C->>B: POST /v1/chat/completions
    Note over B: 1. Auth check<br/>2. Assign turnId + create temp dir<br/>3. Serialize messages → prompt text<br/>4. Write images to temp dir
    B->>B: Start per-turn IPC socket server
    B->>S: generateConfig() → temp/{turnId}/.gemini/settings.json
    Note over S: Includes: model, tools.exclude,<br/>mcpServers (ToolBridge only)
    B->>CLI: Spawn: gemini -y -o stream-json -p "..." --settings temp/{turnId}
    Note over B: SSE headers sent, heartbeat started
    CLI-->>TB: MCP init (stdio)
    TB-->>CLI: tools/list response (all registered tools)
    CLI->>CLI: ReAct reasoning loop
    CLI-->>TB: tools/call {name, arguments}
    TB-->>B: IPC: {event:"tool_call", name, arguments}
    B-->>C: SSE: delta.tool_calls chunk + finish_reason:"tool_calls"
    C->>B: POST (next turn, role:"tool" result)
    B-->>TB: IPC: {event:"tool_result", result}
    TB-->>CLI: MCP tools/call response
    CLI->>CLI: Continues ReAct, generates final text
    CLI-->>B: JSONL: {type:"message", role:"assistant", delta:true}
    B-->>C: SSE: delta.content chunks
    CLI-->>B: JSONL: {type:"result", stats:{...}}
    B-->>C: SSE: final chunk (usage) + data:[DONE]
    B->>B: removeListeners(), close IPC, cleanup temp dir
```

---

## Prompt Serialization

The bridge converts the OpenAI `messages` array into a plain-text prompt string that the Gemini CLI can parse. This is a strict, stateless synthesis — no previous turn state is stored server-side; the client sends the entire conversation history every request.

### Message Role Mapping

| OpenAI Role | Serialized Format |
|---|---|
| `system` | Extracted to `--system-prompt` flag content (separate from main prompt) |
| `user` | `USER: <text>` |
| `assistant` (text only) | `ASSISTANT: <text>` |
| `assistant` (with tool_calls) | `ASSISTANT: <text>\n[ACTION: Called tool '<name>' with args: <json>]` |
| `tool` / `function` | `[TOOL RESULT (<tool_call_id>)]:\n<content>` |

### Full Example

**Input (OpenAI messages)**:
```json
[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user",  "content": "What is the weather?" },
  { "role": "assistant", "content": "", "tool_calls": [{ "function": { "name": "get_weather", "arguments": "{\"city\":\"London\"}" } }] },
  { "role": "tool", "tool_call_id": "call_abc", "content": "Sunny, 22°C" },
  { "role": "user", "content": "Thanks!" }
]
```

**Serialized `conversationPrompt`** (sent to CLI with `-p`):
```
USER: What is the weather?

ASSISTANT:
[ACTION: Called tool 'get_weather' with args: {"city":"London"}]

[TOOL RESULT (call_abc)]:
Sunny, 22°C

USER: Thanks!
```

---

## Input Sanitization

The Gemini CLI interprets lines starting with `@` as **file injection directives** (`@/path/to/file`) and lines starting with `!` as **shell command directives** (`!ls`). To prevent user-provided text from accidentally triggering these:

```
sanitizePromptText:
  for each line in text:
    if line.startsWith('@') OR line.startsWith('!')
      prepend '\' → '\@...' or '\!...'
    else
      pass through unchanged
```

> **Important**: Only the *first character* of each line matters. An email like `user@example.com` mid-line is safe and is NOT escaped.

---

## Image and File Attachment

Ionosphere supports two attachment paths:

### Path 1 — Base64 Data URI (JSON body)

```mermaid
flowchart LR
    A["message.content[]\ntype:'image_url'\nurl:'data:image/png;base64,...'"] -->|"split on ','"| B["base64 payload"]
    B -->|"Buffer.from(b64,'base64')"| C["Write to temp/{turnId}/image_N.png"]
    C -->|"inject into prompt"| D["@/abs/path/image_N.png\n(before text content)"]
    D -->|"CLI expands"| E["Gemini Vision"]
```

The `@` prefix at the start of a line is the CLI's native file reference syntax. The file is written to the per-turn temp directory and referenced absolutely.

### Path 2 — Multipart Form Upload

```mermaid
flowchart LR
    A["multipart/form-data\nfield: file"] -->|"multer.diskStorage"| B["temp/{turnId}/{field}-{timestamp}.ext"]
    B -->|"req.files[]"| C["Bridge reads file paths"]
    C -->|"inject @path into prompt"| D["CLI expands"]
```

Multer routes directly into the per-turn temp directory. Files are available during the turn and garbage-collected afterward.

---

## Temporary Workspace Isolation

Each request gets a fully isolated workspace. This prevents cross-request file contamination and settings collision between concurrent requests.

```
temp/
└── {turnId-uuid}/              ← created on request arrival
    ├── .gemini/
    │   └── settings.json       ← per-turn CLI configuration
    ├── image_1.png             ← decoded base64 images
    ├── image_2.jpeg
    ├── tools.json              ← OpenAI tool definitions (if present)
    ├── mcp_servers.json        ← upstream MCP configs (if present)
    └── tool_ipc.sock           ← Unix socket for ToolBridge IPC (non-Windows)
```

A garbage collector runs every **5 minutes** and deletes any turn directory older than **15 minutes**, catching abandoned workspaces from crashed or disconnected sessions.

---

## Settings Generation (`generate_settings.js`)

For each turn, `generateConfig()` writes a fresh `settings.json` into the turn's temp `.gemini/` directory. The CLI is spawned with `--settings` pointing to this directory.

### Config Structure

```json
{
  "general": { "previewFeatures": true },
  "telemetry": { "enabled": false },
  "privacy": { "usageStatisticsEnabled": false },
  "model": {
    "name": "gemini-2.5-flash-lite",
    "maxSessionTurns": -1
  },
  "tools": {
    "exclude": [
      "list_directory", "read_file", "write_file",
      "glob", "grep_search", "replace", "run_shell_command"
    ]
  },
  "mcpServers": {
    "ionosphere-tool-bridge": {
      "command": "node",
      "args": ["/abs/path/packages/tool-bridge/index.js"],
      "env": {
        "TOOL_BRIDGE_IPC": "\\\\.\\pipe\\ionosphere-{turnId}",
        "TOOL_BRIDGE_TOOLS": "/abs/path/temp/{turnId}/tools.json",
        "TOOL_BRIDGE_MCP_SERVERS": "/abs/path/temp/{turnId}/mcp_servers.json"
      }
    }
  }
}
```

### Key Design Decisions

| Field | Value | Reason |
|---|---|---|
| `maxSessionTurns: -1` | Unlimited | Prevents CLI from silently truncating long context windows |
| `tools.exclude` | All builtins | CLI is "dumb" — it cannot read files, run commands, etc. All tools go through ToolBridge |
| `telemetry.enabled: false` | Disabled | No usage data sent to Google from bridge-invoked sessions |

### Environment Overrides

| Env Var | Effect |
|---|---|
| `GEMINI_MODEL` | Sets `model.name` |
| `GEMINI_DISABLE_TOOLS=false` | Re-enables CLI builtins (not recommended) |
| `GEMINI_DISABLE_WEB_SEARCH=true` | Also excludes `google_web_search` |
| `GEMINI_AUTH_TYPE` | Sets `auth.enforcedAuthType` |
| `SESSION_MODE=stateful` | Enables `SessionRouter` (see below) |

Custom settings from `req.body.customSettings` are deep-merged onto the base config last, allowing per-request overrides without clobbering required fields.

---

## Tool Architecture

### The "Dumb CLI" Principle

The Gemini CLI is intentionally kept as a pure reasoning engine. It cannot autonomously execute tools or reach external APIs. **Every tool call, regardless of its source, is routed back to the client.**

```mermaid
flowchart TD
    subgraph "What the CLI sees"
        CLI["Gemini CLI"]
        TB["ToolBridge MCP\n(sole mcpServers entry)"]
        CLI <-->|"MCP stdio: tools/list, tools/call"| TB
    end

    subgraph "ToolBridge internal routing"
        OAT["OpenAI tools[]\n(client-side functions)"]
        UMC["Upstream MCP servers\n(Context7, GitHub, etc.)"]
        TB -->|"re-exposes as MCP tools"| OAT
        TB -->|"discovers + namespaces as\nserverName__toolName"| UMC
    end

    IPC["IPC Socket"]
    TB -->|"ALL calls → tool_call event"| IPC
    IPC --> Bridge["Bridge emits SSE\ndelta.tool_calls to Client"]
    Client["Client"] -->|"executes tool itself"| Client
    Client -->|"role:tool result"| Bridge
    Bridge -->|"tool_result event"| IPC
    IPC -->|"MCP response to CLI"| TB
```

### OpenAI Tools Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Bridge
    participant TB as ToolBridge
    participant CLI as Gemini CLI

    Note over C,B: Client sends tools:[{name:"get_weather",...}]
    B->>B: Write tools.json to temp dir
    B->>TB: Spawn with TOOL_BRIDGE_TOOLS=/path/tools.json
    TB->>TB: server.tool("get_weather", description, schema, ipcHandler)
    CLI->>TB: tools/call {name:"get_weather", arguments:{city:"London"}}
    TB->>B: IPC: {event:"tool_call", name:"get_weather", arguments:{...}}
    B->>C: SSE delta.tool_calls[{id, type:"function", function:{name, arguments}}]
    Note over B,C: finish_reason:"tool_calls" — client must respond
    C->>C: Execute get_weather("London") → "Sunny, 22°C"
    C->>B: POST {role:"tool", tool_call_id:"call_xyz", content:"Sunny, 22°C"}
    B->>TB: IPC: {event:"tool_result", result:"Sunny, 22°C"}
    TB->>CLI: MCP tools/call response: {content:[{type:"text",text:"Sunny, 22°C"}]}
    CLI->>CLI: Continues reasoning...
```

### MCP Aggregation Flow

When `mcpServers` is provided in the payload, ToolBridge aggregates them:

```mermaid
flowchart LR
    REQ["POST request\nmcpServers:{context7:{serverUrl:'...'}}\ntools:[{name:'get_weather'}]"]

    REQ -->|"written to"| MF["mcp_servers.json\nin temp dir"]
    REQ -->|"written to"| TF["tools.json\nin temp dir"]

    MF -->|"TOOL_BRIDGE_MCP_SERVERS"| TB
    TF -->|"TOOL_BRIDGE_TOOLS"| TB

    TB["ToolBridge"] -->|"MCP Client connects"| C7["Context7\nhttps://mcp.context7.com/mcp"]
    C7 -->|"tools/list → resolve-library-id, get-library-docs"| TB
    TB -->|"re-registers as context7__resolve-library-id\ncontext7__get-library-docs"| SELF["ToolBridge McpServer\n(what CLI sees)"]
    TF -->|"registers get_weather"| SELF

    CLI["Gemini CLI"] <-->|"MCP: all 3 tools visible"| SELF
```

**Key point**: The CLI only has one entry in `mcpServers` — `ionosphere-tool-bridge`. It is completely unaware of Context7 or any upstream server. All 3 tools appear identical to it.

### Tool Naming Convention

| Tool source | CLI-visible name | Example |
|---|---|---|
| OpenAI `tools[]` | `{name}` unchanged | `get_weather` |
| Upstream MCP server | `{serverName}__{toolName}` | `context7__resolve-library-id` |

Double-underscore namespacing prevents collisions when two servers expose tools with the same name.

### IPC Socket Protocol

The IPC layer uses newline-delimited JSON over a named pipe (Windows) or Unix domain socket (Linux/macOS):

**ToolBridge → Bridge** (tool call dispatch):
```json
{"event":"tool_call","name":"get_weather","arguments":{"city":"London"}}\n
```

**Bridge → ToolBridge** (client result):
```json
{"event":"tool_result","result":"Sunny, 22°C"}\n
```

Each tool call occupies exactly one socket connection. The connection is held open until the result is received (or the 10-minute timeout fires). Multiple concurrent calls use multiple simultaneous connections.

---

## CLI JSONL Output (`-o stream-json`)

The Gemini CLI streams newline-delimited JSON to stdout. The `JsonlAccumulator` in `GeminiController.js` reassembles TCP-fragmented chunks into complete lines.

### Event Types

| Event | Key Fields | Bridge action |
|---|---|---|
| `init` | `session_id`, `model` | forwarded to `onEvent` |
| `message` (user) | `role:"user"`, `content` | ignored |
| `message` (assistant) | `role:"assistant"`, `content`, `delta:true` | → `onText` → SSE `delta.content` |
| `tool_use` | `tool_name`, `tool_id`, `parameters` | → `onToolCall` → SSE `delta.tool_calls` |
| `tool_result` | `tool_id`, `status`, `output` | → `onEvent` (informational) |
| `error` | `message`, `code` | → `onError` → SSE `{error}` |
| `result` | `status`, `stats` | → `onResult` → SSE usage chunk + `[DONE]` |

> **Historical note**: Older CLI versions emitted `type:"toolCall"` (camelCase). The bridge handles both names for backward compatibility.

### Token Usage

The `result` event's `stats` block provides token counts which are surfaced in the final SSE chunk:

```json
{ "stats": { "total_tokens": 34392, "input_tokens": 32504, "output_tokens": 746, "tool_calls": 3 } }
```

→ SSE `usage: { "prompt_tokens": 32504, "completion_tokens": 746, "total_tokens": 34392 }`

---

## SSE Output Format

The bridge streams OpenAI-compatible SSE chunks. Every chunk is a `data: <json>\n\n` line.

### Text chunk
```json
{
  "id": "chatcmpl-{turnId}",
  "object": "chat.completion.chunk",
  "created": 1740000000,
  "model": "gemini-cli",
  "choices": [{ "index": 0, "delta": { "content": "Hello " } }]
}
```

### Tool call chunk
```json
{
  "id": "chatcmpl-{turnId}",
  "object": "chat.completion.chunk",
  "created": 1740000000,
  "model": "gemini-cli",
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_a1b2c3d4",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"London\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### Final usage chunk (before `[DONE]`)
```json
{
  "id": "chatcmpl-{turnId}",
  "object": "chat.completion.chunk",
  "created": 1740000000,
  "model": "gemini-cli",
  "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 32504, "completion_tokens": 746, "total_tokens": 34392 }
}
```

```
data: [DONE]
```

---

## Concurrency and Queuing

```mermaid
flowchart TD
    R1["Request 1"] & R2["Request 2"] & R3["Request 3"] & R4["Request 4"] & R5["Request 5"] & R6["Request 6"]-->Q

    Q{"currentlyRunning\n< MAX_CONCURRENT_CLI (5)?"}
    Q -->|"Yes"| EX["Execute immediately\ncurrentlyRunning++"]
    Q -->|"No"| WAIT["Enqueue in requestQueue\n(Promise, resolved when slot opens)"]

    EX --> DONE["Turn complete\ncurrentlyRunning--"]
    DONE -->|"requestQueue.shift()"| NEXT["Unblock next queued request"]
```

Each concurrent turn gets its own:
- `turnId` UUID
- `temp/{turnId}/` workspace
- IPC socket at `\\.\pipe\ionosphere-{turnId}` (Windows) or `temp/{turnId}/tool_ipc.sock` (Unix)
- `settings.json` in `temp/{turnId}/.gemini/`

There is zero shared state between concurrent turns.

---

## Session Modes

### Stateless (default)

Every request receives the full conversation history in `messages[]`. The bridge serializes it entirely into the `-p` prompt. No session is stored. The CLI processes the full context fresh each time.

```
Request N: USER: Hi    | ASSISTANT: Hello | USER: How are you?  → -p "USER: Hi\n\nASSISTANT: Hello\n\nUSER: How are you?"
```

### Stateful (`SESSION_MODE=stateful`)

`SessionRouter` (SQLite-backed) selects which CLI session to resume using **Longest Common Prefix (LCP)** matching:

```mermaid
flowchart TD
    INC["Incoming serialized prompt\n'User: Hi\\nAssist: Hello\\nUser: And you?'"]
    DB[("SQLite sessions store\npayload per session")]
    LCP["Find session where\nstored payload is a prefix\nof incoming → pick longest"]
    NEW["No match → new session\ndelta = entire prompt"]
    CONT["Match found → resume session\ndelta = incoming minus stored prefix"]

    INC --> LCP
    LCP --> DB
    DB -->|"match"| CONT
    DB -->|"no match"| NEW
```

The delta (new content only) is sent to the resumed CLI session, preserving the existing context window without re-sending history.

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `API_KEY` | *(none)* | Bearer token validation (disabled if unset) |
| `GEMINI_CLI_PATH` | `gemini` | Path/command to invoke the Gemini CLI |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Model passed to CLI |
| `SESSION_MODE` | `stateless` | `stateless` \| `stateful` |
| `MAX_CONCURRENT_CLI` | `5` | Max simultaneous CLI processes |
| `GEMINI_DISABLE_TOOLS` | `true` | Set to `false` to re-enable CLI builtins |
| `GEMINI_DISABLE_WEB_SEARCH` | *(unset)* | Set to `true` to also exclude web search |
| `GEMINI_AUTH_TYPE` | *(unset)* | Forces a specific auth type in settings |
| `GEMINI_SETTINGS_JSON` | `.gemini/settings.json` | Only used by the global settings generator |

---

## Security Model

- **API key**: Simple Bearer token validation. If `API_KEY` is unset, all requests are accepted (development mode).
- **Prompt injection**: `sanitizePromptText` escapes `@` and `!` prefixes to prevent user content from triggering CLI file/shell directives.
- **Process isolation**: Each turn spawns a fresh CLI process with a scoped settings file. One turn cannot affect another's context.
- **Filesystem scope**: The CLI's builtin filesystem tools are excluded by default. Without ToolBridge, the CLI cannot read or write any files on the server.

---

## Repository Structure

```
gemini-ionosphere/
├── src/
│   ├── index.js              ← HTTP server, request handling, IPC, SSE emission
│   ├── GeminiController.js   ← CLI spawning, JsonlAccumulator, callback routing
│   ├── SessionRouter.js      ← SQLite-backed LCP session matcher
│   └── PromptDiffer.js       ← (legacy) context differ
├── packages/
│   └── tool-bridge/
│       ├── index.js          ← MCP aggregator server (ToolBridge)
│       └── package.json
├── scripts/
│   └── generate_settings.js  ← Per-turn settings.json generator
├── test/
│   ├── mock_cli.js           ← Scenario-driven mock CLI
│   ├── jsonl_accumulator.test.js
│   ├── event_router.test.js
│   ├── prompt_serial.test.js
│   ├── ipc_bridge.test.js
│   ├── settings_gen.test.js
│   ├── api_compliance.test.js
│   ├── controller.test.js
│   └── router.test.js
└── temp/                     ← Per-turn workspaces (auto-created, GC'd after 15min)
```
