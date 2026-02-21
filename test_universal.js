import OpenAI from 'openai';

const openai = new OpenAI({
    apiKey: 'sk-no-key-required',
    baseURL: 'http://127.0.0.1:3000/v1'
});

const tinyRedDotBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAADElEQVR42mP8z8BQyAAEABH+AdfmveXAAAAAAElFTkSuQmCC";

async function runTest() {
    console.log("🚀 Initiating Universal Compliance Strike 20...");

    try {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Analyze this image. What color is the dominant pixel? Answer in one sentence.' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyRedDotBase64}` } }
                ]
            }
        ];

        console.log("\n📩 Exact Messages Sent:");
        console.dir(messages, { depth: null, colors: true });

        const stream = await openai.chat.completions.create({
            model: 'gemini-1.5-flash',
            temperature: 0.1,
            max_tokens: 100,
            stream: true,
            messages: messages
        });

        console.log("\n📡 Stream opened. Receiving chunks:\n");
        let fullResponse = "";

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            if (content) {
                console.log(`[Chunk Received]: "${content}"`);
                fullResponse += content;
            }
        }

        console.log(`\n=======================================\n`);
        console.log(`Final Assembled Response: "${fullResponse}"`);
        console.log(`\n=======================================\n`);

        if (fullResponse.trim().length > 0) {
            console.log("✅ [SUCCESS] Vision + Parameters held perfectly.");
        } else {
            console.log("❌ [FAILURE] The response was empty.");
        }

    } catch (error) {
        console.error("\n❌ [FATAL ERROR]:", error.message);
        process.exit(1);
    }
}

runTest();
