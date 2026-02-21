# Ionosphere

**Ionosphere** is a strictly stateless HTTP bridge for the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli). It allows you to use the Gemini CLI as a backend reasoning engine for any OpenAI-compatible application while maintaining high-efficiency tool loops via a **Warm Stateless Handoff** strategy.

Ionosphere is ideal for workflows where:
- Tools are defined as MCP servers (stdio).
- Multi-step reasoning (ReAct) is handled by the model.
- Privacy is a priority (no server-side conversation storage).

---

## Why Ionosphere?

| Feature | Description |
|---|---|
| **Warm Stateless Handoff** | Keeps CLI processes "warm" during tool loops in-memory without persistent state. |
| **Strictly Stateless** | No local database or session files. Every request is a clean slate from a storage perspective. |
| **Isolated Workspaces** | Every turn gets a throwaway `temp/` workspace for images, logs, and IPC sockets. |
| **Wait-Free Queuing** | Internal concurrency management to prevent CPU starvation under high load. |
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
