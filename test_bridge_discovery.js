
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

async function testDiscovery() {
    const bridgePath = path.resolve('packages/tool-bridge/index.js');
    console.log(`[Test] Connecting to bridge at ${bridgePath}...`);

    const transport = new StdioClientTransport({
        command: 'node',
        args: [bridgePath],
        env: {
            ...process.env,
            TOOL_BRIDGE_IPC: '/tmp/test-ipc.sock',
            TOOL_BRIDGE_TOOLS: 'temp/45c64466-d980-41dd-84ae-ad8362905da7/tools.json'
        }
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
        await client.connect(transport);
        console.log('[Test] Connected!');

        const { tools } = await client.listTools();
        console.log(`[Test] Discovered ${tools.length} tools:`);
        tools.forEach(t => console.log(`  - ${t.name}`));

        const hasRead = tools.some(t => t.name === 'read_file');
        const hasPrefixedRead = tools.some(t => t.name === 'ionosphere__read_file');

        if (hasRead && hasPrefixedRead) {
            console.log('[Test] SUCCESS: Both read_file and ionosphere__read_file discovered.');
        } else {
            console.error('[Test] FAILURE: Missing aliases.');
        }

        await client.close();
    } catch (err) {
        console.error(`[Test] ERROR: ${err.message}`);
        process.exit(1);
    }
}

testDiscovery();
