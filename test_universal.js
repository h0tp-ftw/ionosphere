import OpenAI from 'openai';

const openai = new OpenAI({
    apiKey: 'sk-no-key-required',
    baseURL: 'http://localhost:3000/v1'
});

const tinyRedDotBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function runTest() {
    console.log("🚀 Initiating Universal Compliance Strike...");

    try {
        const stream = await openai.chat.completions.create({
            model: 'gemini-2.5-flash', 
            temperature: 0.0,
            max_tokens: 50,
            stream: true,
            messages: [
                { 
                    role: 'system', 
                    content: 'You are a highly logical vision analyzer. You MUST use your native vision capabilities to answer. DO NOT write code. DO NOT use tools. DO NOT attempt to use Python. Just look at the image and give your best assessment.' 
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Analyze this image. What color is the dominant pixel? Answer in one sentence.' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyRedDotBase64}` } }
                    ]
                }
            ]
        });

        console.log("\n📡 Stream opened. Receiving chunks:\n");
        let fullResponse = "";

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            if (content) {
                process.stdout.write(content);
                fullResponse += content;
            }
        }

        console.log(`\n\n✅ [SUCCESS] Execution complete.`);

    } catch (error) {
        console.error("\n❌ [FATAL ERROR]:", error.message);
        process.exit(1);
    }
}

runTest();