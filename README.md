# 🌠 Ionosphere

**Ionosphere** is a strictly stateless HTTP bridge for the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli), allowing you to use the Gemini CLI in any OpenAI-compatible application.

It is designed for advanced workflows, including:
- 🤖 **Agentic & ReAct Workflows**: Built for multi-step tool calls.
- 🔎 **Search Grounding**: Native access to Google Search via the CLI.
- 📚 **Long Contexts**: Leverage Gemini's massive context window.
- ⚡ **Stateless Efficiency**: "Warm Stateless Handoff" keeps processes ready without persistent state.

---

## 📖 Table of Contents

- [Why Ionosphere?](#why-ionosphere)
- [System Requirements](#system-requirements)
- [Installation](#installation)
  - [Local Setup](#local-setup)
  - [Docker Setup](#docker-setup)
- [Configuration](#configuration)
  - [Authentication](#authentication)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
  - [Starting the Server](#starting-the-server)
  - [Making Requests](#making-requests)
  - [Available Models](#available-models)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Motivation](#motivation)

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

## Installation

### Local Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/h0tp-ftw/gemini-ionosphere.git
    cd gemini-ionosphere
    ```

2.  **Install dependencies and run setup:**
    ```bash
    npm install
    npm run setup
    ```
    The setup script will guide you through creating an API key for the bridge and configuring your environment.

### Docker Setup

For a containerized deployment, please refer to the [Docker Instructions](DOCKER_README.md).

---

## Configuration

### Authentication

Ionosphere requires two layers of authentication:

1.  **Bridge Security (Client → Ionosphere)**:
    -   Protected via **Bearer Token Authentication**.
    -   A unique `API_KEY` is generated during setup (stored in `.env`).
    -   Use this key in your OpenAI-compatible client as the API Key.

2.  **Provider Authentication (Ionosphere → Google)**:
    -   **OAuth (Google Account)**: Run `gemini auth login` locally.
    -   **API Key (Google AI Studio)**: Set `GEMINI_API_KEY` in `.env`.
    -   **Vertex AI (Google Cloud)**: Set `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION` in `.env`.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_CLI_PATH` | `gemini` | Path to the Gemini CLI binary. |
| `API_KEY` | — | Bearer token for bridge security (generated during setup). |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Default model if none is specified in the request. |
| `MAX_CONCURRENT_CLI` | `5` | Maximum number of simultaneous CLI processes. |
| `PORT` | `3000` | Port for the Express server. |

---

## Usage

### Starting the Server

```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in `.env`).

### Making Requests

You can interact with Ionosphere using any OpenAI-compatible client or via `curl`.

**Example `curl` request:**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello! What can you do?"}
    ],
    "stream": true
  }'
```

For detailed API documentation, including how to use MCP servers and file injection, see [API.md](API.md).

### Available Models

The following models are supported:

- `auto-gemini-3`
- `auto-gemini-2.5`
- `gemini-3-pro-preview`
- `gemini-3-flash-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite` (Default)
- `gemini-2.0-flash`

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

---

## Architecture

Ionosphere uses a unique "Warm Stateless Handoff" strategy to bridge the stateful Gemini CLI to a stateless HTTP API.

For a deep dive into how it works, including the request lifecycle and security model, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Known Limitations

- **OAuth Reliability**: CLI OAuth depends on server availability; API keys are preferred for stable uptime.
- **Infinite Looping**: Complex tool interactions may occasionally cause loops.
- **Process Overhead**: Higher latency due to containerized I/O and process spawning compared to direct API usage. Not suitable for high-frequency parallel executions.
- **Stateless**: Ionosphere does not persist state between requests (by design).

---

## Troubleshooting

### Common Issues

-   **Port already in use**: ensure no other process is running on port 3000 (or your configured port).
-   **Authentication Failures**:
    -   Check if your `API_KEY` in `.env` matches the one in your client.
    -   Verify your Google credentials (`gemini auth login` or API keys) are valid.
-   **CLI Errors**: Ensure the Gemini CLI is installed and accessible via `gemini`.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

---

## License

License information not available.

---

## Motivation

I have been using the Gemini CLI since its launch and have worked with it extensively. Knowing firsthand how powerful this tool is, I built this project to enable others to easily integrate it into their own workflows and agentic loops. In the past, I have used the Gemini CLI in a number of projects, but I found that I needed to build a lot of the same functionality over and over again. I also found that the Gemini CLI was not as easy to use as I would have liked, and I wanted to make it easier for others to use it.

Before the OpenClaw times, I had a whole personal assistant running via Gemini CLI (jeeves). I found that Gemini CLI was not easy to develop with for novel use cases, which is why I bridged it via an OpenAI compatible API.
