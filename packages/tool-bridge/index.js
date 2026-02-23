#!/usr/bin/env node
/**
 * Ionosphere ToolBridge — Universal MCP Aggregator + OpenAI Adapter
 *
 * Spawned once per request turn by the Ionosphere bridge.
 * Acts as a unified gateway that:
 *
 *   1. Reads OpenAI-format tool definitions (TOOL_BRIDGE_TOOLS) and registers
 *      each as a named MCP tool. When the Gemini CLI calls one, it is forwarded
 *      via IPC → SSE to the client for client-side execution.
 *
 *   2. Reads upstream MCP server configs (TOOL_BRIDGE_MCP_SERVERS) and connects
 *      to each as an MCP client. Discovers their tools, re-exposes them to the
 *      Gemini CLI under namespaced names ({serverName}__{toolName}). When the
 *      CLI calls one, it is also forwarded via IPC → SSE to the client.
 *      The client is always the executor — the CLI never calls upstream servers.
 *
 * Environment variables:
 *   TOOL_BRIDGE_TOOLS       — Path to JSON file: OpenAI tools array (optional)
 *   TOOL_BRIDGE_MCP_SERVERS — Path to JSON file: mcpServers config object (optional)
 *   TOOL_BRIDGE_IPC         — Named pipe / Unix socket path for IPC (required)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import net from 'net';
import fs from 'fs';

// ─── Configuration ────────────────────────────────────────────────────────────

const ipcPath = process.env.TOOL_BRIDGE_IPC;
if (!ipcPath) {
    process.stderr.write('[ToolBridge] FATAL: TOOL_BRIDGE_IPC must be set.\n');
    process.exit(1);
}

// Global Error Handling to prevent silent discovery crashes
process.on('uncaughtException', (err) => {
    process.stderr.write(`[ToolBridge] FATAL UNCAUGHT EXCEPTION: ${err.stack || err}\n`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[ToolBridge] FATAL UNHANDLED REJECTION: ${reason?.stack || reason}\n`);
    process.exit(1);
});

let openAiTools = [];
if (process.env.TOOL_BRIDGE_TOOLS) {
    try {
        openAiTools = JSON.parse(fs.readFileSync(process.env.TOOL_BRIDGE_TOOLS, 'utf-8'));
    } catch (err) {
        process.stderr.write(`[ToolBridge] WARN: Failed to read TOOL_BRIDGE_TOOLS: ${err.message}\n`);
    }
}

let mcpServerConfigs = {};
if (process.env.TOOL_BRIDGE_MCP_SERVERS) {
    try {
        mcpServerConfigs = JSON.parse(fs.readFileSync(process.env.TOOL_BRIDGE_MCP_SERVERS, 'utf-8'));
    } catch (err) {
        process.stderr.write(`[ToolBridge] WARN: Failed to read TOOL_BRIDGE_MCP_SERVERS: ${err.message}\n`);
    }
}

// ─── IPC Dispatch ─────────────────────────────────────────────────────────────

/**
 * Sends a tool_call event over the IPC socket and awaits a tool_result reply.
 * The bridge in index.js holds this open until the client sends the result
 * back in a subsequent role:tool message.
 *
 * @param {string} name - The tool name (may be namespaced: serverName__toolName)
 * @param {object|string} args - The tool arguments
 * @returns {Promise<string>}
 */
function dispatchToolCall(name, args) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(ipcPath, () => {
            const payload = JSON.stringify({
                event: 'tool_call',
                name,
                arguments: args
            }) + '\n';
            client.write(payload);
        });

        let buffer = '';
        client.on('data', (chunk) => {
            buffer += chunk.toString();
            const nl = buffer.indexOf('\n');
            if (nl !== -1) {
                const line = buffer.slice(0, nl).trim();
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

        client.on('error', (err) => reject(new Error(`[ToolBridge] IPC error: ${err.message}`)));

        const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS) || 120 * 60 * 1000;
        const t = setTimeout(() => {
            client.destroy();
            reject(new Error(`[ToolBridge] IPC reply timed out after ${TURN_TIMEOUT_MS / 60000} minutes.`));
        }, TURN_TIMEOUT_MS);

        client.on('close', () => clearTimeout(t));
    });
}

// ─── MCP Client Factory ───────────────────────────────────────────────────────

/**
 * Connects an MCP client to an upstream server using the appropriate transport.
 * Supports stdio (command/args) and HTTP (serverUrl with StreamableHTTP + SSE fallback).
 *
 * @param {string} serverName
 * @param {object} config - { command, args, env } or { serverUrl, headers }
 * @returns {Promise<Client>}
 */
async function connectUpstreamMcp(serverName, config) {
    const mcpClient = new Client({ name: `ionosphere-tool-bridge-${serverName}`, version: '1.0.0' });

    if (config.command) {
        // stdio transport — spawn the upstream server process
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args || [],
            env: { ...process.env, ...(config.env || {}) }
        });
        await mcpClient.connect(transport);
        process.stderr.write(`[ToolBridge] Connected to upstream MCP (stdio): ${serverName}\n`);
        return mcpClient;
    }

    if (config.serverUrl) {
        const baseUrl = new URL(config.serverUrl);
        const headers = config.headers || {};

        // Try StreamableHTTP first (modern), fall back to SSE (legacy)
        try {
            const transport = new StreamableHTTPClientTransport(baseUrl, { requestInit: { headers } });
            await mcpClient.connect(transport);
            process.stderr.write(`[ToolBridge] Connected to upstream MCP (StreamableHTTP): ${serverName}\n`);
            return mcpClient;
        } catch {
            process.stderr.write(`[ToolBridge] StreamableHTTP failed for ${serverName}, falling back to SSE...\n`);
            const fallbackClient = new Client({ name: `ionosphere-tool-bridge-${serverName}`, version: '1.0.0' });
            const transport = new SSEClientTransport(baseUrl, { eventSourceInit: { headers } });
            await fallbackClient.connect(transport);
            process.stderr.write(`[ToolBridge] Connected to upstream MCP (SSE): ${serverName}\n`);
            return fallbackClient;
        }
    }

    throw new Error(`[ToolBridge] Unknown transport config for server "${serverName}": ${JSON.stringify(config)}`);
}

// ─── Tool Registration Helpers ────────────────────────────────────────────────

function makeIpcHandler(toolName) {
    return async (args) => {
        try {
            // Strip internal MCP objects that might leak into args from some SDK versions
            const cleanArgs = { ...args };
            delete cleanArgs.signal;
            delete cleanArgs.requestId;

            process.stderr.write(`[ToolBridge] → IPC dispatch: ${toolName}. Args: ${JSON.stringify(cleanArgs)}\n`);
            const result = await dispatchToolCall(toolName, cleanArgs);
            process.stderr.write(`[ToolBridge] ← IPC result received for: ${toolName}\n`);
            const stringified = typeof result === 'string' ? result : JSON.stringify(result);
            return { content: [{ type: 'text', text: stringified }] };
        } catch (err) {
            process.stderr.write(`[ToolBridge] Error dispatching ${toolName}: ${err.message}\n`);
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
    };
}

function openaiParamsToInputSchema(parameters) {
    if (!parameters || typeof parameters !== 'object') {
        return { type: 'object', properties: {}, required: [] };
    }
    const schema = { ...parameters };
    if (!schema.required) schema.required = [];
    return schema;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'ionosphere-tool-bridge', version: '1.0.0' });

// 1. Register OpenAI-format tools (client-side execution via IPC)
for (const toolDef of openAiTools) {
    const fn = toolDef.function ?? toolDef;
    const { name, description, parameters } = fn;
    if (!name) continue;

    // Namespacing: Standardize on ionosphere__ prefix.
    const namespacedName = name.startsWith('ionosphere__') ? name : `ionosphere__${name}`;

    const schema = {
        ...openaiParamsToInputSchema(parameters),
        description: description ?? `Client-side tool: ${name}`
    };

    process.stderr.write(`[ToolBridge] Registering OpenAI tool: ${namespacedName}\n`);
    if (process.env.GEMINI_DEBUG_TOOLS === 'true') {
        process.stderr.write(`[ToolBridge] Schema for ${namespacedName}: ${JSON.stringify(schema, null, 2)}\n`);
    }

    try {
        server.tool(
            namespacedName,
            schema,
            makeIpcHandler(namespacedName) // Always use namespaced name for IPC
        );
    } catch (e) {
        process.stderr.write(`[ToolBridge] ERROR: Failed to register tool ${namespacedName}: ${e.message}\n`);
    }
}

// 2. Connect to upstream MCP servers, discover tools, re-register under namespace
const serverEntries = Object.entries(mcpServerConfigs);
if (serverEntries.length > 0) {
    process.stderr.write(`[ToolBridge] Aggregating ${serverEntries.length} upstream MCP server(s)...\n`);
}

for (const [serverName, config] of serverEntries) {
    if (config.disabled) {
        process.stderr.write(`[ToolBridge] Skipping disabled server: ${serverName}\n`);
        continue;
    }

    try {
        const upstreamClient = await connectUpstreamMcp(serverName, config);
        const { tools } = await upstreamClient.listTools();

        process.stderr.write(`[ToolBridge] Discovered ${tools.length} tool(s) from ${serverName}\n`);

        for (const tool of tools) {
            // Namespace to avoid collisions: serverName__toolName
            const namespacedName = `${serverName}__${tool.name}`;

            process.stderr.write(`[ToolBridge] Re-registering: ${namespacedName}\n`);

            const schema = {
                ...(tool.inputSchema ?? { type: 'object', properties: {} }),
                description: `[${serverName}] ${tool.description ?? tool.name}`
            };

            try {
                server.tool(
                    namespacedName,
                    schema,
                    async (args) => {
                        try {
                            process.stderr.write(`[ToolBridge] → Calling upstream tool: ${namespacedName}\n`);
                            // Strip internal MCP SDK args if present
                            const cleanArgs = { ...args };
                            delete cleanArgs.signal;
                            delete cleanArgs.requestId;

                            const result = await upstreamClient.callTool({ name: tool.name, arguments: cleanArgs });
                            process.stderr.write(`[ToolBridge] ← Upstream result received for: ${namespacedName}\n`);

                            // Consolidate content blocks into a single string
                            const text = result.content.map(c => {
                                if (c.type === 'text') return c.text;
                                return JSON.stringify(c);
                            }).join('\n');

                            return { content: [{ type: 'text', text: String(text) }] };
                        } catch (err) {
                            process.stderr.write(`[ToolBridge] Error calling upstream ${namespacedName}: ${err.message}\n`);
                            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
                        }
                    }
                );
            } catch (e) {
                process.stderr.write(`[ToolBridge] ERROR: Failed to register upstream tool ${namespacedName}: ${e.message}\n`);
            }
        }
    } catch (err) {
        process.stderr.write(`[ToolBridge] WARN: Failed to aggregate server "${serverName}": ${err.message}\n`);
    }
}

// 3. Start the MCP stdio server (the Gemini CLI connects to this)
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[ToolBridge] MCP server running on stdio — all tool calls routed via IPC.\n');
