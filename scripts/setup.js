import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise(resolve => rl.question(query, resolve));

async function checkTermsOfService() {
    console.log("By using Ionosphere and the Gemini CLI, you agree to follow the Google API and Gemini CLI Terms of Service.");
    console.log("Please review them before proceeding.");
    const agree = await question("Do you agree to these Terms of Service? (y/N): ");
    if (agree.toLowerCase() !== 'y') {
        console.error("❌ You must agree to the Terms of Service to use this software. Exiting.");
        process.exit(1);
    }
    console.log("✅ Terms of Service accepted.\n");
}

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
        console.warn("  (Note: Containerization is RECOMMENDED. You can still run Ionosphere natively for development.)");
    }
    console.log("✅ Dependencies check complete.\n");
}

async function setupEnvAndAuth(isNative, composeCmd) {
    const envPath = path.join(process.cwd(), '.env');

    // Generate a high-entropy unique API key for the bridge
    const ionoKey = `iono_sk_${randomBytes(24).toString('hex')}`;
    const envContent = `GEMINI_CLI_PATH=gemini\nGEMINI_SETTINGS_JSON=./settings.json\nAPI_KEY=${ionoKey}\n`;

    if (fs.existsSync(envPath)) {
        console.log(`✅ .env file already exists at ${envPath}.`);
        const overwrite = await question("Do you want to overwrite it? (y/N): ");
        if (overwrite.toLowerCase() !== 'y') {
            const currentEnv = fs.readFileSync(envPath, 'utf-8');
            const match = currentEnv.match(/^API_KEY=(.*)$/m);
            return match ? match[1] : undefined;
        }
    }

    console.log("\n--- Authentication Configuration ---");
    console.log("Ionosphere uses the standard Gemini CLI OAuth flow for authentication.");
    console.log("This ensures maximum security and zero credential drift.");

    // Enforce OAuth in the generated settings.json
    process.env.GEMINI_AUTH_TYPE = 'oauth-personal';

    if (isNative) {
        const hasGemini = spawnSync('gemini', ['--version'], { encoding: 'utf-8' });
        if (hasGemini.error) {
            console.error("\n❌ `gemini` is not installed on your host machine. Please install it with `npm install -g @google/gemini-cli`.");
            process.exit(1);
        } else {
            console.log("\n`gemini` is installed locally. Triggering Native OAuth login flow...");
            console.log("NOTE: A browser window will open to authenticate. Once done, type /quit to return to this installer.");
            // Use positional prompt instead of -p to avoid flag conflicts in some shells
            spawnSync('gemini', ['"Auth check complete! Please type /quit to return to the installer."'], { stdio: 'inherit', shell: true });
        }
    } else {
        console.log("\nContainer mode selected. Building Image...");
        // Build the image quickly so we can use its CLI.
        spawnSync(`${composeCmd}`, ['build'], { stdio: 'inherit', shell: true });

        console.log("\nTriggering Isolated Container OAuth Flow...");
        console.log("The Gemini CLI will launch inside the container and open a browser link for authentication.");
        console.log("Once authenticated, type /quit to exit the CLI and return to this installer.");
        // Use positional prompt instead of -p to avoid flag conflicts
        spawnSync(`${composeCmd}`, ['run', '--rm', 'ionosphere', 'gemini', '"Auth check complete! Please type /quit to return to the installer."'], { stdio: 'inherit', shell: true });
    }

    fs.writeFileSync(envPath, envContent, 'utf-8');
    console.log("✅ Created .env file.");
    return ionoKey;
}

async function setupPreferences() {
    console.log("\n--- Settings Configuration ---");
    const telemetry = await question("Disable telemetry? (Y/n): ");
    process.env.GEMINI_DISABLE_TELEMETRY = telemetry.toLowerCase() === 'n' ? 'false' : 'true';

    const preview = await question("Enable preview models? (Y/n): ");
    process.env.GEMINI_ENABLE_PREVIEW = preview.toLowerCase() === 'n' ? 'false' : 'true';

    const tools = await question("Disable inbuilt tools (read/write files, shell commands) by default? (Y/n): ");
    process.env.GEMINI_DISABLE_TOOLS = tools.toLowerCase() === 'n' ? 'false' : 'true';

    const search = await question("Disable Google Web Search tool as well? (y/N): ");
    process.env.GEMINI_DISABLE_WEB_SEARCH = search.toLowerCase() === 'y' ? 'true' : 'false';
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
        await checkTermsOfService();
        await checkDependencies();

        console.log("\n--- Setup Environment ---");
        const envChoice = await question("How will you run Ionosphere?\n[1] Native (Node.js) - NOT RECOMMENDED for production\n[2] Docker\n[3] Podman\nSelect [1/2/3] (default: 1): ");
        const isNative = envChoice === '1' || envChoice === '';
        const isDocker = envChoice === '2';
        const isPodman = envChoice === '3';

        let composeCmd = '';
        if (isDocker) composeCmd = 'docker-compose';
        if (isPodman) {
            const hasPodmanCompose = !spawnSync('podman-compose', ['--version'], { encoding: 'utf-8' }).error;
            composeCmd = hasPodmanCompose ? 'podman-compose' : 'podman compose';
        }

        const ionoKey = await setupEnvAndAuth(isNative, composeCmd);
        await setupPreferences();
        await generateSettings();

        console.log("\n=========================================");
        console.log("🎉 Setup Complete!");
        console.log("=========================================\n");

        if (ionoKey) {
            console.log("🔑 YOUR IONOSPHERE API KEY:");
            console.log(`   ${ionoKey}`);
            console.log("\nCopy this key into your AI applications (Roo Code, opencode, etc.)\n");
        }

        const startNow = await question("Start the server now? (y/N): ");
        rl.close();

        if (startNow.toLowerCase() === 'y') {
            const cmd = isNative ? 'npm start' : `${composeCmd} up -d --build`;
            console.log(`\n🚀 Starting the Ionosphere server...`);
            if (!isNative) console.log(`⏳ (This may take a minute if the image needs building)\n`);

            // Execute the command directly as a string with shell: true for best compatibility on Windows
            const result = spawnSync(cmd, { stdio: 'inherit', shell: true });

            if (result.error) {
                console.error(`❌ Failed to start the server: ${result.error.message}`);
            } else if (!isNative) {
                console.log(`\n✅ Server is running in the background.`);
                console.log(`📝 To view logs, run: ${composeCmd} logs -f\n`);
            }
        }

    } catch (err) {
        console.error("Setup failed:", err);
        rl.close();
    }
}

main();
