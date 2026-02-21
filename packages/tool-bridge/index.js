#!/usr/bin/env node
/**
 * Ionosphere ToolBridge — Ephemeral MCP stdio Server
 *
 * Spawned once per request turn by the Ionosphere bridge.
 * Reads OpenAI-format tool definitions and registers each as a named MCP tool.
 * When the Gemini CLI calls one of those tools, this process:
 *   1. Writes a tool_call JSON message to the IPC socket.
 *   2. Waits for a tool_result reply from the bridge.
 *   3. Returns the result as MCP tool content, allowing the CLI to continue.
 *
 * Environment variables:
 *   TOOL_BRIDGE_TOOLS  — Path to a JSON file containing an OpenAI tools array.
 *   TOOL_BRIDGE_IPC    — Path to the named pipe / Unix socket for IPC.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import net from 'net';
import fs from 'fs';

// ─── Configuration ────────────────────────────────────────────────────────────

const toolsFilePath = process.env.TOOL_BRIDGE_TOOLS;
const ipcPath = process.env.TOOL_BRIDGE_IPC;

if (!toolsFilePath || !ipcPath) {
    process.stderr.write('[ToolBridge] FATAL: TOOL_BRIDGE_TOOLS and TOOL_BRIDGE_IPC must be set.\n');
    process.exit(1);
}

let toolDefinitions = [];
try {
    toolDefinitions = JSON.parse(fs.readFileSync(toolsFilePath, 'utf-8'));
} catch (err) {
    process.stderr.write(`[ToolBridge] FATAL: Failed to read tools file ${toolsFilePath}: ${err.message}\n`);
    process.exit(1);
}

// ─── IPC Channel ──────────────────────────────────────────────────────────────

/**
 * Sends a tool_call over the IPC socket and awaits a tool_result reply.
 * The bridge holds this promise open until the client sends back the result
 * in a subsequent request, at which point it writes the reply on the socket.
 *
 * @param {string} name - The tool name.
 * @param {object} args - The tool arguments.
 * @returns {Promise<string>} - The string result from the client.
 */
function dispatchToolCall(name, args) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(ipcPath, () => {
            const payload = JSON.stringify({ event: 'tool_call', name, arguments: args }) + '\n';
            client.write(payload);
        });

        let buffer = '';
        client.on('data', (chunk) => {
            buffer += chunk.toString();
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                client.destroy();
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.event === 'tool_result') {
                        resolve(parsed.result ?? '');
                    } else {
                        reject(new Error(`[ToolBridge] Unexpected IPC event: ${parsed.event}`));
                    }
                } catch (e) {
                    reject(new Error(`[ToolBridge] Failed to parse IPC reply: ${line}`));
                }
            }
        });

        client.on('error', (err) => {
            reject(new Error(`[ToolBridge] IPC connection error: ${err.message}`));
        });

        // Hard timeout: if the bridge doesn't reply in 10 minutes, abort.
        const t = setTimeout(() => {
            client.destroy();
            reject(new Error('[ToolBridge] IPC reply timed out after 10 minutes.'));
        }, 10 * 60 * 1000);

        client.on('close', () => clearTimeout(t));
    });
}

// ─── OpenAI JSON Schema → Zod-free raw schema helper ─────────────────────────

/**
 * The MCP SDK accepts raw JSON Schema objects when using the low-level Server API.
 * We map from OpenAI's function.parameters (which is already JSON Schema) directly.
 */
function openaiParamsToInputSchema(parameters) {
    if (!parameters || typeof parameters !== 'object') {
        return { type: 'object', properties: {} };
    }
    return parameters;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'ionosphere-tool-bridge',
    version: '1.0.0',
});

for (const toolDef of toolDefinitions) {
    // Support both OpenAI formats:
    //   { type: 'function', function: { name, description, parameters } }
    //   { name, description, parameters }   (bare format)
    const fn = toolDef.function ?? toolDef;
    const { name, description, parameters } = fn;

    if (!name) {
        process.stderr.write(`[ToolBridge] Skipping tool with no name: ${JSON.stringify(toolDef)}\n`);
        continue;
    }

    process.stderr.write(`[ToolBridge] Registering tool: ${name}\n`);

    server.tool(
        name,
        description ?? `Client-side tool: ${name}`,
        openaiParamsToInputSchema(parameters),
        async (args) => {
            try {
                process.stderr.write(`[ToolBridge] Tool called: ${name} args=${JSON.stringify(args)}\n`);
                const result = await dispatchToolCall(name, args);
                process.stderr.write(`[ToolBridge] Tool result received for ${name}\n`);
                return {
                    content: [{ type: 'text', text: String(result) }]
                };
            } catch (err) {
                process.stderr.write(`[ToolBridge] Error executing ${name}: ${err.message}\n`);
                return {
                    content: [{ type: 'text', text: `Error: ${err.message}` }],
                    isError: true
                };
            }
        }
    );
}

// ─── Launch ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[ToolBridge] MCP server running on stdio.\n');
