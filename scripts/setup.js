import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
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
            console.log("NOTE: A browser window will open to authenticate.");
            console.log("If the CLI stays interactive, type /quit to return to this installer.\n");

            const prompt = "you have been run as part of an auth script, and if you generated a response, it has succeeded. please tell the user, Auth check complete! Please type /quit to return to the installer if the CLI is still interactive.";
            // Pass command as a single string when using shell: true to avoid DEP0190
            spawnSync(`gemini "${prompt}"`, { stdio: 'inherit', shell: true });
        }
    } else {
        console.log("\nContainer mode selected. Building Image...");
        // Pass build args to ensure Scorched Earth hardening is applied during image build
        const buildArgs = `--build-arg GEMINI_DISABLE_TOOLS=${process.env.GEMINI_DISABLE_TOOLS || 'false'} --build-arg GEMINI_DISABLE_WEB_SEARCH=${process.env.GEMINI_DISABLE_WEB_SEARCH || 'false'}`;
        spawnSync(`${composeCmd} build ${buildArgs}`, { stdio: 'inherit', shell: true });

        console.log("\nTriggering Isolated Container OAuth Flow...");
        console.log("The Gemini CLI will launch inside the container and open a browser link for authentication.");
        console.log("If the CLI stays interactive, type /quit to return to this installer.\n");

        const prompt = "you have been run as part of an auth script, and if you generated a response, it has succeeded. please tell the user, Auth check complete! Please type /quit to return to the installer if the CLI is still interactive.";
        spawnSync(`${composeCmd} run --rm ionosphere gemini -p "${prompt}"`, { stdio: 'inherit', shell: true });
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

async function nukeNativeTools() {
    if (process.env.GEMINI_DISABLE_TOOLS === 'true' || process.env.GEMINI_DISABLE_WEB_SEARCH === 'true') {
        console.log("\n--- Triggering Refined Scorched Earth Tool Deletion ---");
        spawnSync('node', ['scripts/nuke-tools.js'], {
            stdio: 'inherit',
            env: process.env
        });
    }
}

async function main() {
    console.log("=========================================");
    console.log("🚀 Ionosphere Native Orchestrator Setup");
    console.log("=========================================\n");

    try {
        if (fs.existsSync(path.join(process.cwd(), '.env'))) {
            console.log("--- Maintenance Option ---");
            console.log("An existing .env was detected.");
            const maintenance = await question("Would you like to enter the Maintenance Menu? (y/N): ");

            if (maintenance.toLowerCase() === 'y') {
                console.log("\n[1] Recover/View existing API Key");
                console.log("[2] Fresh Build (Nuke containers, volumes, and images)");
                console.log("[3] Back to Main Setup");
                const mChoice = await question("Select Choice [1/2/3]: ");

                if (mChoice === '1') {
                    const currentEnv = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
                    const match = currentEnv.match(/^API_KEY=(.*)$/m);
                    if (match) {
                        console.log("\n🔑 YOUR CURRENT IONOSPHERE API KEY:");
                        console.log(`   ${match[1]}\n`);
                    } else {
                        console.log("❌ API_KEY not found in .env.");
                    }
                    rl.close();
                    return;
                }

                if (mChoice === '2') {
                    console.log("\n🧨 Nuking current container state...");
                    // Try to detect compose command
                    const dockerStatus = spawnSync('docker', ['--version']);
                    const podmanStatus = spawnSync('podman', ['--version']);
                    let cCmd = dockerStatus.error ? 'podman compose' : 'docker-compose';
                    if (!podmanStatus.error && spawnSync('podman-compose', ['--version']).status === 0) cCmd = 'podman-compose';

                    spawnSync(cCmd, ['down', '--volumes', '--rmi', 'all'], { stdio: 'inherit', shell: true });
                    console.log("✅ State purged. Proceeding with fresh setup...\n");
                }
                // Option 3 just continues to standard flow
            }
        }

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
        await nukeNativeTools();

        console.log("\n=========================================");
        console.log("🎉 Setup Complete!");
        console.log("=========================================\n");

        if (ionoKey) {
            console.log("🔑 YOUR IONOSPHERE API KEY:");
            console.log(`   ${ionoKey}`);
            console.log("\nCopy this key into your AI applications (any OpenAI-compatible SDK or client)\n");
        }

        const startNow = await question("Start the server now? (y/N): ");
        rl.close();

        if (startNow.toLowerCase() === 'y') {
            console.log(`\n🚀 Starting the Ionosphere server...`);

            // Start the server
            if (isNative) {
                console.log(`\n🚀 Starting the Ionosphere server...\n`);
                spawnSync('npm start', { stdio: 'inherit', shell: true });
                rl.close();
            } else {
                console.log(`\n🏗️  Building Ionosphere image...`);
                console.log(`⏳ (This may take a few minutes for the first build or code changes)\n`);

                const buildArgs = `--build-arg GEMINI_DISABLE_TOOLS=${process.env.GEMINI_DISABLE_TOOLS || 'false'} --build-arg GEMINI_DISABLE_WEB_SEARCH=${process.env.GEMINI_DISABLE_WEB_SEARCH || 'false'}`;
                // Use spawn for the build to ensure real-time output streaming on all platforms
                const buildProcess = spawn(`${composeCmd} build ${buildArgs}`, { stdio: 'inherit', shell: true });

                buildProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`\n🚀 Launching detached bridge container...`);

                        // Now run 'up -d'
                        const upProcess = spawn(`${composeCmd} up -d`, { stdio: 'inherit', shell: true });

                        upProcess.on('exit', (upCode) => {
                            if (upCode === 0) {
                                console.log(`\n✅ Server is running in the background.`);
                                console.log(`📝 To view logs, run: ${composeCmd} logs -f\n`);

                                // Finally close the readline and exit
                                rl.close();
                                process.exit(0);
                            } else {
                                console.error(`\n❌ Failed to launch containers (Exit code: ${upCode}).`);
                                rl.close();
                                process.exit(upCode);
                            }
                        });
                    } else {
                        console.error(`\n❌ Build failed (Exit code: ${code}). Please check the errors above.`);
                        rl.close();
                        process.exit(code);
                    }
                });
            }
        } else {
            rl.close();
        }

    } catch (err) {
        console.error("Setup failed:", err);
        rl.close();
    }
}

main();
