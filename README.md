# 🌠 Ionosphere

**Ionosphere** is a stateless HTTP bridge for the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli), allowing Gemini CLI usage in any OpenAI-compatible application.

Ionosphere is designed for workflows with:
- Agentic work / Multi-step / tool call ReAct workflows
- Search grounding (built-in Google search tool)
- Long contexts (Gemini CLI has generous context length)

Ionosphere is NOT designed for workflows with:
- Persistent state or storage (Ionosphere is stateless)
- High frequency / parallel requests (Latency is high)

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

### 1. Interactive Setup

```bash
npm run setup
```

This script generates your `.env` and `settings.json` based on your preferred auth (OAuth, API Key, or Vertex).

### 2. Run Natively (Development)

```bash
npm install
npm start
```

### 3. Run via Docker (Production)

```bash
docker-compose up --build
```

The Docker image includes the Gemini CLI and provides a secure, isolated environment for your agentic loops.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_CLI_PATH` | `gemini` | Path to the Gemini CLI binary |
| `API_KEY` | — | Bearer token for bridge security |
| `GEMINI_MODEL` | `gemini-2.0-flash-exp` | Default model |
| `MAX_CONCURRENT_CLI` | `5` | Max simultaneous CLI processes |
| `PORT` | `3000` | Express server port |

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
