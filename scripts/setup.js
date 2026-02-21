import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

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
    const envContent = `GEMINI_CLI_PATH=gemini\nGEMINI_SETTINGS_JSON=./settings.json\n`;

    if (fs.existsSync(envPath)) {
        console.log(`✅ .env file already exists at ${envPath}.`);
        const overwrite = await question("Do you want to overwrite it? (y/N): ");
        if (overwrite.toLowerCase() !== 'y') {
            return;
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
            spawnSync('gemini', ['-p', 'Auth check complete! Please tell the user that authentication was successful and they can type /quit to exit and return to the Ionosphere installer.'], { stdio: 'inherit', shell: true });
        }
    } else {
        console.log("\nContainer mode selected. Building Image...");
        // Build the image quickly so we can use its CLI.
        spawnSync(`${composeCmd}`, ['build'], { stdio: 'inherit', shell: true });

        console.log("\nTriggering Isolated Container OAuth Flow...");
        console.log("The Gemini CLI will launch inside the container and open a browser link for authentication.");
        console.log("Once authenticated, type /quit to exit the CLI and return to this installer.");
        spawnSync(`${composeCmd}`, ['run', '--rm', 'ionosphere', 'gemini', '-p', 'Auth check complete! Please tell the user that authentication was successful and they can type /quit to exit and return to the Ionosphere installer.'], { stdio: 'inherit', shell: true });
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
        const envChoice = await question("How will you run Ionosphere?\n[1] Native (Node.js) - NOT RECOMMENDED for production\n[2] Docker (RECOMMENDED)\n[3] Podman\nSelect [1/2/3] (default: 1): ");
        const isNative = envChoice === '1' || envChoice === '';
        const isDocker = envChoice === '2';
        const isPodman = envChoice === '3';

        let composeCmd = '';
        if (isDocker) composeCmd = 'docker-compose';
        if (isPodman) {
            const hasPodmanCompose = !spawnSync('podman-compose', ['--version'], { encoding: 'utf-8' }).error;
            composeCmd = hasPodmanCompose ? 'podman-compose' : 'podman compose';
        }

        await setupEnvAndAuth(isNative, composeCmd);
        await setupPreferences();
        await generateSettings();

        console.log("\n=========================================");
        console.log("🎉 Setup Complete!");
        console.log("=========================================\n");

        const startNow = await question("Start the server now? (y/N): ");
        rl.close();

        if (startNow.toLowerCase() === 'y') {
            const cmd = isNative ? 'npm start' : `${composeCmd} up --build`;
            console.log(`\nRun the following command to start the server:\n\n  ${cmd}\n`);
        }

    } catch (err) {
        console.error("Setup failed:", err);
        rl.close();
    }
}

main();
