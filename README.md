# Ionosphere

**Ionosphere** is a persistent, stateful orchestrator and API bridge for the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli). Instead of spawning a new CLI process for every request, Ionosphere keeps the CLI alive as a long-running child process and pipes prompts to it over stdio — preserving the full conversation context window across requests.

---

## Why Ionosphere?

| Problem | Standard API Approach | Ionosphere |
|---|---|---|
| Context window | Rebuilt from scratch every request | Persistent — CLI retains full history |
| Long agent loops | Connection drops after 30s–2min | Infinite socket timeout + 15s heartbeat |
| Concurrent requests | Race conditions | Mutex queue — serialized cleanly |
| Client disconnects | Zombie processes, wiped context | SIGINT physics — CLI survives, context preserved |
| Stateless client history bloat | Full history re-sent every turn | LCP Context Differ strips redundant payload |

---

## System Requirements

- **OS**: macOS 15+, Windows 11 24H2+, Ubuntu 20.04+
- **Node.js**: 20.0.0+
- **Docker** or **Podman** *(optional, for containerized deployment)*
- **Gemini CLI**: Installed locally (`npm install -g @google/gemini-cli`) or auto-installed in container

---

## Quick Start

### 1. Interactive Setup

```bash
npm run setup
```

This will:
- Check for Node.js, Docker/Podman
- Ask for your authentication method (OAuth, API Key, or Vertex AI)
- Trigger the `gemini` OAuth flow inline if the binary is on PATH
- Ask about telemetry and preview model preferences
- Generate `settings.json` and `.env`
- Offer to launch the orchestrator immediately (Native / Docker / Podman)

### 2. Run Natively

```bash
npm install
npm start
```

### 3. Run via Docker

```bash
docker-compose up --build
```

The Docker image automatically installs the Gemini CLI at build time. Pass `GEMINI_CLI_TAG=preview` to install a non-stable release:

```bash
docker-compose build --build-arg GEMINI_CLI_TAG=preview
```

### 4. Run via Podman

```bash
podman compose up --build
# or, if podman-compose is installed via pip:
podman-compose up --build
```

---

## Authentication

Configure authentication before running. The setup script handles this interactively.

### OAuth (Personal — Recommended)

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
| `GEMINI_SETTINGS_JSON` | `~/.gemini/settings.json` | Path to the CLI settings file |
| `GEMINI_API_KEY` | — | API Key auth |
| `GOOGLE_API_KEY` | — | Vertex AI auth |
| `GOOGLE_GENAI_USE_VERTEXAI` | — | Set `true` for Vertex AI |
| `GOOGLE_CLOUD_PROJECT` | — | GCP project ID |
| `GOOGLE_CLOUD_LOCATION` | — | GCP region |
| `PORT` | `3000` | Express server port |

---

## npm Scripts

| Command | Description |
|---|---|
| `npm start` | Start the orchestrator HTTP server |
| `npm run setup` | Interactive first-run setup wizard |
| `npm run generate-settings` | Regenerate `settings.json` only |
| `npm test` | Run the automated test suite |

---

## Project Structure

```
gemini-ionosphere/
├── src/
│   ├── index.js            # Express HTTP server — the relay layer
│   ├── GeminiController.js # Core CLI orchestrator with Mutex, State Machine, GC
│   └── ContextDiffer.js    # LCP context stripper for stateless clients
├── scripts/
│   ├── setup.js            # Interactive setup wizard
│   └── generate_settings.js # Generates ~/.gemini/settings.json
├── test/
│   ├── controller.test.js  # GeminiController unit tests
│   └── differ.test.js      # ContextDiffer unit tests
├── Dockerfile              # Single-stage Node.js build with gemini CLI baked in
├── docker-compose.yml      # Single-service deployment
└── .env.example            # Environment variable template
```
