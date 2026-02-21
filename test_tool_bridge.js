/**
 * test_tool_bridge.js
 *
 * Integration test for the Ionosphere ToolBridge adapter.
 * Tests that OpenAI-format tool definitions in the request payload are
 * correctly proxied through the Gemini CLI and returned as proper
 * OpenAI SSE tool_calls delta chunks.
 *
 * Run with: node test_tool_bridge.js
 * Requires: Ionosphere bridge running at http://localhost:3000
 */

import OpenAI from 'openai';

const openai = new OpenAI({
    apiKey: 'sk-no-key-required',
    baseURL: 'http://localhost:3000/v1'
});

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const tools = [
    {
        type: 'function',
        function: {
            name: 'get_current_time',
            description: 'Returns the current date and time in ISO 8601 format.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Returns current weather conditions for a given city.',
            parameters: {
                type: 'object',
                properties: {
                    city: {
                        type: 'string',
                        description: 'The name of the city to get weather for.'
                    }
                },
                required: ['city']
            }
        }
    }
];

// ─── Turn 1: Trigger a Tool Call ───────────────────────────────────────────────

async function runTurn1() {
    console.log('─'.repeat(60));
    console.log('🔄 Turn 1: Asking a question that should trigger a tool call...');
    console.log('─'.repeat(60));

    let detectedToolCall = null;
    let textChunks = '';

    const stream = await openai.chat.completions.create({
        model: 'gemini-2.5-flash',
        stream: true,
        tools,
        tool_choice: 'auto',
        messages: [
            {
                role: 'system',
                content: 'You are a helpful assistant. When answering questions about current time or weather, you MUST use the provided tools. Do not guess. Always call the appropriate tool.'
            },
            {
                role: 'user',
                content: 'What is the current time?'
            }
        ]
    });

    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
            process.stdout.write(delta.content);
            textChunks += delta.content;
        }

        if (delta?.tool_calls) {
            const tc = delta.tool_calls[0];
            if (!detectedToolCall) {
                detectedToolCall = tc;
                console.log('\n\n🛠️  Tool call chunk intercepted:');
                console.log(JSON.stringify(tc, null, 2));
            }
        }
    }

    if (!detectedToolCall) {
        console.log('\n⚠️  No tool call detected in Turn 1 (model may have answered directly).');
        console.log('    This may indicate the model did not use tools, or no tools were triggered.');
        return null;
    }

    // Validate OpenAI compliance
    const checks = {
        'type === function': detectedToolCall.type === 'function',
        'index is number': typeof detectedToolCall.index === 'number',
        'id present': !!detectedToolCall.id,
        'function.name present': !!detectedToolCall.function?.name,
    };

    console.log('\n📋 Compliance checks:');
    let allPass = true;
    for (const [check, result] of Object.entries(checks)) {
        const icon = result ? '✅' : '❌';
        console.log(`   ${icon} ${check}`);
        if (!result) allPass = false;
    }

    if (allPass) {
        console.log('\n✅ Turn 1 PASSED — Tool call is fully OpenAI compliant.');
    } else {
        console.log('\n❌ Turn 1 FAILED — Tool call is NOT OpenAI compliant.');
        process.exit(1);
    }

    return detectedToolCall;
}

// ─── Turn 2: Send Tool Result and Get Final Answer ─────────────────────────────

async function runTurn2(toolCall) {
    console.log('\n' + '─'.repeat(60));
    console.log('🔄 Turn 2: Sending tool result and expecting final text answer...');
    console.log('─'.repeat(60));

    const fakeResult = new Date().toISOString();
    console.log(`📤 Submitting tool result: ${fakeResult}`);

    const stream = await openai.chat.completions.create({
        model: 'gemini-2.5-flash',
        stream: true,
        tools,
        tool_choice: 'auto',
        messages: [
            {
                role: 'system',
                content: 'You are a helpful assistant. When answering questions about current time or weather, you MUST use the provided tools. Do not guess. Always call the appropriate tool.'
            },
            {
                role: 'user',
                content: 'What is the current time?'
            },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: toolCall.id,
                    type: 'function',
                    function: {
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments || '{}'
                    }
                }]
            },
            {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: fakeResult
            }
        ]
    });

    let finalText = '';
    let toolCallInTurn2 = false;

    process.stdout.write('\n📝 Final response: ');
    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
            process.stdout.write(delta.content);
            finalText += delta.content;
        }
        if (delta?.tool_calls) {
            toolCallInTurn2 = true;
        }
    }

    console.log('\n');

    if (toolCallInTurn2) {
        console.log('⚠️  Another tool call was made in Turn 2 (loop may be forming).');
    }

    if (finalText.length > 0) {
        console.log('✅ Turn 2 PASSED — Got a final text response after tool result.');
    } else {
        console.log('❌ Turn 2 FAILED — No text response received after tool result.');
        process.exit(1);
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n🚀 Ionosphere ToolBridge Integration Test\n');

    try {
        const toolCall = await runTurn1();
        if (toolCall) {
            await runTurn2(toolCall);
        }
        console.log('\n🎉 All tests complete.\n');
    } catch (err) {
        console.error('\n💥 Fatal error:', err.message);
        process.exit(1);
    }
}

main();
