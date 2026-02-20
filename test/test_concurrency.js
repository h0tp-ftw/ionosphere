import fs from 'fs';
import path from 'path';

async function main() {
    console.log("Starting Concurrency Stress Test...");
    const url = 'http://localhost:3000/v1/chat/completions';

    const makeRequest = async (id) => {
        try {
            console.log(`[Req ${id}] Sending...`);
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: `Identity check: Are you request ${id}? Wait 1 second before answering.` }]
                })
            });
            const text = await res.text();
            console.log(`[Req ${id}] Received ${text.length} chars. (Status: ${res.status})`);
            return { id, success: res.status === 200 };
        } catch (e) {
            console.error(`[Req ${id}] Failed:`, e.message);
            return { id, success: false };
        }
    };

    const promises = Array.from({ length: 3 }, (_, i) => makeRequest(i + 1));
    const results = await Promise.all(promises);

    const successes = results.filter(r => r.success).length;
    console.log(`\nStress Test Completed: ${successes}/3 successful.`);

    // Check temp directory
    const tempDir = path.join(process.cwd(), 'temp');
    if (fs.existsSync(tempDir)) {
        const dirs = fs.readdirSync(tempDir, { withFileTypes: true }).filter(d => d.isDirectory());
        console.log(`Temp directories remaining: ${dirs.length}`);
    }
}

main();
