#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import net from 'net';
import fs from 'fs';

const ipcPath = process.env.TOOL_BRIDGE_IPC;
if (!ipcPath) {
    process.stderr.write('[ToolBridge] FATAL: TOOL_BRIDGE_IPC must be set.\n');
    process.exit(1);
}

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

async function connectUpstreamMcp(serverName, config) {
    const mcpClient = new Client({ name: `ionosphere-tool-bridge-${serverName}`, version: '1.0.0' });
    if (config.command) {
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

/**
 * LOW-LEVEL MCP SERVER
 * We use the base Server class and setRequestHandlers directly to bypass 
 * Zod-based validation and ensure 100% schema fidelity for the Gemini CLI.
 */

const server = new Server({
    name: "ionosphere-tool-bridge",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});

const toolsMap = new Map();

// 1. OpenAI Adapter Tools
for (const toolDef of openAiTools) {
    const fn = toolDef.function ?? toolDef;
    const name = fn.name;
    if (!name) continue;
    const namespacedName = name.startsWith('ionosphere__') ? name : `ionosphere__${name}`;

    toolsMap.set(namespacedName, {
        name: namespacedName,
        description: fn.description ?? `Client-side tool: ${name}`,
        inputSchema: fn.parameters || { type: 'object', properties: {}, required: [] },
        handler: async (args) => {
            const cleanArgs = { ...args };
            delete cleanArgs.signal;
            delete cleanArgs.requestId;
            process.stderr.write(`[ToolBridge] → IPC dispatch: ${namespacedName}. Args: ${JSON.stringify(cleanArgs)}\n`);
            const result = await dispatchToolCall(namespacedName, cleanArgs);
            process.stderr.write(`[ToolBridge] ← IPC result received for: ${namespacedName}\n`);
            const stringified = typeof result === 'string' ? result : JSON.stringify(result);
            return { content: [{ type: 'text', text: stringified }] };
        }
    });
}

// 2. Upstream Aggregated Tools
const serverEntries = Object.entries(mcpServerConfigs);
for (const [serverName, config] of serverEntries) {
    if (config.disabled) continue;
    try {
        const upstreamClient = await connectUpstreamMcp(serverName, config);
        const { tools } = await upstreamClient.listTools();
        process.stderr.write(`[ToolBridge] Discovered ${tools.length} tool(s) from ${serverName}\n`);
        for (const tool of tools) {
            const namespacedName = `ionosphere__${serverName}__${tool.name}`;
            process.stderr.write(`[ToolBridge] Re-registering upstream tool: ${namespacedName}\n`);
            toolsMap.set(namespacedName, {
                name: namespacedName,
                description: `[${serverName}] ${tool.description ?? tool.name}`,
                inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
                handler: async (args) => {
                    const cleanArgs = { ...args };
                    delete cleanArgs.signal;
                    delete cleanArgs.requestId;
                    const result = await upstreamClient.callTool({ name: tool.name, arguments: cleanArgs });
                    const text = result.content.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
                    return { content: [{ type: 'text', text: String(text) }] };
                }
            });
        }
    } catch (err) {
        process.stderr.write(`[ToolBridge] WARN: Failed to aggregate server "${serverName}": ${err.message}\n`);
    }
}

// 3. Register Request Handlers
server.setRequestHandler({ method: 'tools/list' }, async () => {
    return {
        tools: Array.from(toolsMap.values()).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
        }))
    };
});

server.setRequestHandler({ method: 'tools/call' }, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsMap.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler(args);
});

// 4. Connect and Run
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[ToolBridge] MCP server running on stdio — all tool calls routed via IPC.\n');
