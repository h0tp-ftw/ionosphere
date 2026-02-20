import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise(resolve => rl.question(query, resolve));

async function checkDependencies() {
    console.log("Checking dependencies...");
    const nodeStatus = spawnSync('node', ['--version']);
    if (nodeStatus.error) {
        console.error("❌ Node.js is not installed. Please install Node.js v20+.");
        process.exit(1);
    }

    const dockerStatus = spawnSync('docker', ['--version']);
    const podmanStatus = spawnSync('podman', ['--version']);

    if (dockerStatus.error && podmanStatus.error) {
        console.warn("⚠️ Neither Docker nor Podman is installed.");
        console.warn("  (Note: Containerization is optional. You can still run Ionosphere natively using Node.js & Python)");
    }
    console.log("✅ Dependencies check complete.\n");
}

async function setupEnvAndAuth() {
    const envPath = path.join(process.cwd(), '.env');
    let envContent = `GEMINI_CLI_PATH=gemini\nGEMINI_SETTINGS_JSON=./settings.json\n`;

    if (fs.existsSync(envPath)) {
        console.log(`✅ .env file already exists at ${envPath}.`);
        const overwrite = await question("Do you want to overwrite it? (y/N): ");
        if (overwrite.toLowerCase() !== 'y') {
            return;
        }
    }

    console.log("\n--- Authentication Configuration ---");
    console.log("1. OAuth (Personal / gemini auth login)");
    console.log("2. API Key (Google AI Studio)");
    console.log("3. Vertex AI (Google Cloud)");
    const authChoice = await question("Select authentication method [1/2/3] (default: 1): ");

    if (authChoice === '2') {
        const apiKey = await question("Enter your Gemini API Key (GEMINI_API_KEY): ");
        envContent += `GEMINI_API_KEY=${apiKey}\n`;
    } else if (authChoice === '3') {
        const apiKey = await question("Enter your Google API Key for Vertex AI (GOOGLE_API_KEY): ");
        const project = await question("Enter your Google Cloud Project: ");
        const location = await question("Enter your Google Cloud Location (e.g. us-central1): ");
        envContent += `GOOGLE_API_KEY=${apiKey}\nGOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=${project}\nGOOGLE_CLOUD_LOCATION=${location}\n`;
    } else {
        // OAuth — enforcedAuthType will be injected into settings.json
        process.env.GEMINI_AUTH_TYPE = 'oauth-personal';

        const hasGemini = spawnSync('gemini', ['--version'], { encoding: 'utf-8' });
        if (hasGemini.error) {
            console.log("\n⚠️  `gemini` is not installed locally.");
            console.log("   The CLI will be installed inside the container at build time.");
            console.log("   Run `gemini auth login` inside the container on first boot.");
        } else {
            console.log("\n`gemini` is installed locally. Triggering OAuth flow now...");
            console.log("A browser window will open to authenticate. The setup will continue after.");
            // `gemini -p` triggers the OAuth browser flow if not already authenticated,
            // then returns after receiving a valid response — perfect for setup scripts.
            spawnSync('gemini', ['-p', 'This is a setup test, please reply with the word READY.'], {
                stdio: 'inherit'
            });
            console.log("✅ Gemini CLI authenticated and responsive.");
        }
    }

    fs.writeFileSync(envPath, envContent, 'utf-8');
    console.log("✅ Created .env file.");
}

async function setupPreferences() {
    console.log("\n--- Settings Configuration ---");
    const telemetry = await question("Disable telemetry? (Y/n): ");
    process.env.GEMINI_DISABLE_TELEMETRY = telemetry.toLowerCase() === 'n' ? 'false' : 'true';

    const preview = await question("Enable preview models? (Y/n): ");
    process.env.GEMINI_ENABLE_PREVIEW = preview.toLowerCase() === 'n' ? 'false' : 'true';
}

async function generateSettings() {
    console.log("\n--- Generating Settings Block list ---");
    // Pass the populated environment variables over to generate_settings.js
    spawnSync('node', ['scripts/generate_settings.js'], {
        stdio: 'inherit',
        env: process.env
    });
}

async function main() {
    console.log("=========================================");
    console.log("🚀 Ionosphere Native Orchestrator Setup");
    console.log("=========================================\n");

    try {
        await checkDependencies();
        await setupEnvAndAuth();
        await setupPreferences();
        await generateSettings();

        console.log("\n=========================================");
        console.log("🎉 Setup Complete!");
        console.log("=========================================\n");

        const startChoice = await question("Would you like to start the orchestrator now?\n[1] Native (Node.js)\n[2] Docker\n[3] Podman\n[4] Exit\nSelect [1/2/3/4] (default: 4): ");

        // We close readline before spawning long-running servers so it doesn't trap input
        rl.close();

        if (startChoice === '1') {
            console.log("\nStarting Natively...");
            // Pass as a string to avoid DEP0190 shell escaping warning
            spawnSync('npm start', { stdio: 'inherit', shell: true });
        } else if (startChoice === '2') {
            console.log("\nStarting via Docker...");
            spawnSync('docker-compose up --build', { stdio: 'inherit', shell: true });
        } else if (startChoice === '3') {
            console.log("\nStarting via Podman...");
            // Prefer `podman-compose` (pip package) if installed, otherwise fall back
            // to `podman compose` which is built into Podman Desktop on Windows/Mac.
            const hasPodmanCompose = !spawnSync('podman-compose', ['--version'], { encoding: 'utf-8' }).error;
            const composeCmd = hasPodmanCompose ? 'podman-compose up --build' : 'podman compose up --build';
            console.log(`   Using: ${composeCmd}`);
            spawnSync(composeCmd, { stdio: 'inherit', shell: true });
        } else {
            console.log("\nExiting. To start later:");
            console.log("   Native: npm start");
            console.log("   Docker: docker-compose up --build");
            console.log("   Podman: podman compose up --build   (or podman-compose up --build)");
        }

    } catch (err) {
        console.error("Setup failed:", err);
        rl.close();
    }
}

main();
