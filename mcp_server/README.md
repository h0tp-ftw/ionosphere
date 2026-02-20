# Ionosphere MCP Server

This is the Python Model Context Protocol (MCP) server for the Gemini Native Orchestrator. It uses `FastMCP` to expose local tools over `stdio`.

## Tools

*   **`filesystem_manager`**: Read, write, list, search, and delete files.
*   **`web_browser`**: Headless Chromium automation via Playwright (navigate, click, fill, evaluate, get text).

## Installation

1. Create a virtual environment (optional but recommended)
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Install Playwright browser binaries:
   ```bash
   playwright install chromium
   ```

## Running

The orchestrator will start the server automatically using the `stdio` transport system. If running manually for testing, you can use:

```bash
python -m mcp_server.server
```
