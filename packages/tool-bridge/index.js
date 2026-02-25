#!/usr/bin/env node
/**
 * Ionosphere ToolBridge — Low-Level MCP Aggregator
 * 
 * DEFINITIVE VERSION:
 * - Uses base Server class (no McpServer overhead/Zod clashing).
 * - Implements Universal Aliasing: 'ionosphere__read_file' AND 'read_file'.
 * - Preserves Raw JSON Schemas for 100% parameter fidelity.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import net from 'net';
import fs from 'fs';

// --- CONFIG ---
const ipcPath = process.env.TOOL_BRIDGE_IPC;
if (!ipcPath) {
    process.stderr.write('[ToolBridge] FATAL: TOOL_BRIDGE_IPC must be set.\n');
    process.exit(1);
}

// --- ERROR HANDLING ---
process.on('uncaughtException', (err) => {
    process.stderr.write(`[ToolBridge] FATAL UNCAUGHT EXCEPTION: ${err.stack || err}\n`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[ToolBridge] FATAL UNHANDLED REJECTION: ${reason?.stack || reason}\n`);
    process.exit(1);
});

// --- TOOL LOADING ---
let openAiTools = [];
if (process.env.TOOL_BRIDGE_TOOLS) {
    try {
        openAiTools = JSON.parse(fs.readFileSync(process.env.TOOL_BRIDGE_TOOLS, 'utf-8'));
    } catch (err) {
        process.stderr.write(`[ToolBridge] WARN: Failed to read TOOL_BRIDGE_TOOLS: ${err.message}\n`);
    }
}

// --- IPC DISPATCH ---
function dispatchToolCall(name, args) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(ipcPath, () => {
            if (process.env.GEMINI_DEBUG_IPC === 'true') {
                process.stderr.write(`[ToolBridge] → IPC Connected: ${ipcPath}. Calling ${name}...\n`);
            }
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
                if (process.env.GEMINI_DEBUG_IPC === 'true') {
                    process.stderr.write(`[ToolBridge] ← IPC Data received for ${name}: ${line.substring(0, 200)}...\n`);
                }
                client.destroy();
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.event === 'tool_result') {
                        resolve(parsed.result ?? '');
                    } else {
                        reject(new Error(`Unexpected IPC event: ${parsed.event}`));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse IPC reply: ${line}`));
                }
            }
        });

        client.on('error', (err) => {
            process.stderr.write(`[ToolBridge] IPC CONNECTION ERROR: ${err.message}\n`);
            reject(new Error(`IPC error: ${err.message}`));
        });
        const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS) || 120 * 60 * 1000;
        const t = setTimeout(() => {
            client.destroy();
            process.stderr.write(`[ToolBridge] IPC TIMEOUT after ${TURN_TIMEOUT_MS / 60000}m for ${name}\n`);
            reject(new Error(`IPC reply timed out after ${TURN_TIMEOUT_MS / 60000} minutes.`));
        }, TURN_TIMEOUT_MS);
        client.on('close', () => {
            if (process.env.GEMINI_DEBUG_IPC === 'true') {
                process.stderr.write(`[ToolBridge] IPC Socket closed for ${name}\n`);
            }
            clearTimeout(t);
        });
    }).catch(err => {
        return `Error: ${err.message}`;
    });
}

// --- MAIN SERVER ---
const server = new Server({
    name: "ionosphere-tool-bridge",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});

const toolsRegistry = new Map();

// 1. Process OpenAI Tools
for (const toolDef of openAiTools) {
    const fn = toolDef.function || toolDef;
    const name = fn.name;
    if (!name) continue;

    // Simplified Tool Registry: We use the tool's natural name.
    // Collision security is now handled at the registrant level via Selective Blindness.
    const schema = {
        name: name,
        description: fn.description || `Proxy tool: ${name}`,
        inputSchema: fn.parameters || { type: 'object', properties: {} }
    };

    const handler = async (args) => {
        const cleanArgs = { ...args };
        delete cleanArgs.signal;
        delete cleanArgs.requestId;
        process.stderr.write(`[ToolBridge] → Calling ${name}. Args: ${JSON.stringify(cleanArgs)}\n`);
        const result = await dispatchToolCall(name, cleanArgs);
        process.stderr.write(`[ToolBridge] ← Result received for: ${name}\n`);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return { content: [{ type: 'text', text }] };
    };

    toolsRegistry.set(name, { schema, handler });
}

// 2. Set Handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: Array.from(toolsRegistry.values()).map(t => t.schema)
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsRegistry.get(name);
    if (!tool) {
        throw new Error(`Tool "${name}" not found in bridge. Available: ${Array.from(toolsRegistry.keys()).join(', ')}`);
    }
    return tool.handler(args);
});

// 3. Connect
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[ToolBridge] Base Server Bridge started. Handling ${toolsRegistry.size} tools.\n`);
