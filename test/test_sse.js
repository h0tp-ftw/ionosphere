import { OpenAI } from 'openai';

const client = new OpenAI({
    apiKey: 'dummy-key',
    baseURL: 'http://localhost:3000/v1'
});

async function main() {
    console.log("Testing SSE Compliance via OpenAI SDK...");
    try {
        const stream = await client.chat.completions.create({
            model: 'gemini-cli',
            messages: [{ role: 'user', content: 'Say hello world!' }],
            stream: true,
        });

        let responseText = "";
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            process.stdout.write(content);
            responseText += content;
        }

        console.log("\n\n[Success] Stream completed and parsed successfully!");
    } catch (e) {
        console.error("[Error] Test Failed:", e);
    }
}

main();
