# 🌠 Ionosphere

**Ionosphere** is a stateless HTTP bridge for the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli), allowing Gemini CLI usage in any OpenAI-compatible application.

Ionosphere is designed for workflows with:
- Agentic work / Multi-step / tool call ReAct workflows
- Search grounding (built-in Google search tool)
- Long contexts (Gemini CLI has generous context length)


```markdown
### Known Limitations
- **OAuth Reliability**: CLI OAuth depends on server availability; API keys are preferred for stable uptime.
- **Infinite Looping**: Known to occasionally "mess up" or enter infinite loops during complex tool interactions.
- **Process Overhead**: High latency due to the containerized I/O and Node.js process spawning stack compared to direct API usage. Bad for high frequency or parallel executions.
- **Stateless**: Ionosphere is stateless, meaning it does not persist state between requests.
```

---

## Why Ionosphere?

| Feature | Description |
|---|---|
| **Warm Stateless Handoff** | Keeps CLI processes "warm" during tool loops in-memory without persistent state. |
| **Gemini CLI Based** | Easily use any Gemini CLI auth method (OAuth, API Key, Vertex). Use your Google AI subscription for higher limits. |
| **Isolated Workspaces** | Every turn gets a throwaway `temp/` workspace for images, logs, and IPC sockets. |
| **Containerized** | Run with Docker or Podman with garbage collection of session info. |
| **MCP Aggregation** | Automatically namespaces and routes multiple upstream MCP servers through a single bridge. |

---

## System Requirements

- **OS**: macOS 15+, Windows 11 24H2+, Ubuntu 20.04+
- **Node.js**: 20.0.0+
- **Docker** or **Podman** *(Recommended for production)*
- **Gemini CLI**: Installed locally (`npm install -g @google/gemini-cli`)

---

## Quick Start

```bash
npm run setup
```
---

## Authentication

Configure authentication before running. The setup script handles this interactively.

### 1. Bridge Security (Client to Ionosphere)

To protect your bridge, Ionosphere uses **Bearer Token Authentication**. A unique key is generated during setup:

```env
# .env
API_KEY=iono_sk_...
```

The setup script displays this key. Copy it into your AI app's **API Key** field and set the **Base URL** to `http://localhost:3000/v1`.

### 2. Provider Authentication (Ionosphere to Google)

Ionosphere supports three ways to authenticate the underlying Gemini CLI with Google:

#### OAuth (Google Account)

```bash
gemini auth login
# or trigger inline:
gemini -p "Hi"
```

For settings.json enforcement, the setup injects:
```json
{ "auth": { "enforcedAuthType": "oauth-personal" } }
```

### API Key (Google AI Studio)

Set in `.env`:
```env
GEMINI_API_KEY=your-key-here
```

### Vertex AI (Google Cloud)

Set in `.env`:
```env
GOOGLE_API_KEY=your-key-here
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your-project
GOOGLE_CLOUD_LOCATION=us-central1
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_CLI_PATH` | `gemini` | Path to the Gemini CLI binary |
| `API_KEY` | — | Bearer token for bridge security |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Default model |
| `MAX_CONCURRENT_CLI` | `5` | Max simultaneous CLI processes |
| `PORT` | `3000` | Express server port |

## Available Models

Any of the following model identifiers can be passed in the `model` field of the API request:

- `auto-gemini-3` (Auto-selecting Gemini 3)
- `auto-gemini-2.5` (Auto-selecting Gemini 2.5)
- `gemini-3-pro-preview`
- `gemini-3-flash-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite` (Default)

---

## Project Structure

```
gemini-ionosphere/
├── src/
│   ├── index.js            # Handoff Orchestrator — manages parked CLI turns
│   └── GeminiController.js # Stateless CLI Spawner & Stream Parser
├── packages/
│   └── tool-bridge/        # MCP Aggregator (The "Dumb CLI" Bridge)
├── scripts/
│   └── generate_settings.js # Generates per-turn settings.json
├── test/
│   ├── controller.test.js  # Controller unit tests
│   └── ipc_bridge.test.js  # IPC socket verification
├── Dockerfile              # Node.js + Gemini CLI image
└── .env.example            # Environment template
```
```markdown
## Motivation

I have been using the Gemini CLI since its launch and have worked with it extensively. Knowing firsthand how powerful this tool is, I built this project to enable others to easily integrate it into their own workflows and agentic loops. In the past, I have used the Gemini CLI in a number of projects, but I found that I needed to build a lot of the same functionality over and over again. I also found that the Gemini CLI was not as easy to use as I would have liked, and I wanted to make it easier for others to use it.

Before the OpenClaw times, I had a whole personal assistant running via Gemini CLI (jeeves). I found that Gemini CLI was not easy to develop with for novel use cases, which is why I bridged it via an OpenAI compatible API.
```
