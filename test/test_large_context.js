async function main() {
    console.log("Starting Large Context Handling Test...");
    const url = 'http://localhost:3000/v1/chat/completions';

    const padding = "A".repeat(50000);
    const content = `Please summarize the following text: ${padding} \n\n End of text. Just say "A lot of As".`;

    try {
        console.log(`Sending request with ${content.length} characters...`);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content }]
            })
        });
        const text = await res.text();
        console.log(`Received ${text.length} chars. (Status: ${res.status})`);
        console.log(`Preview:`, text.slice(0, 100));
        console.log(`\n[Success] Large context handled successfully!`);
    } catch (e) {
        console.error(`Failed:`, e.message);
    }
}

main();
