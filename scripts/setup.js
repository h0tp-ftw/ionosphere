import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';

async function checkTermsOfService() {
    console.log("By using Ionosphere and the Gemini CLI, you agree to follow the Google API and Gemini CLI Terms of Service.");
    console.log("Please review them before proceeding.");

    const { agree } = await inquirer.prompt([{
        type: 'confirm',
        name: 'agree',
        message: 'Do you agree to these Terms of Service?',
        default: false
    }]);

    if (!agree) {
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

/**
 * Helper to run a command interactively with proper TTY and stdin/stdout inheritance.
 * Forces manual auth and suppresses CLI relaunching to prevent terminal locking on Windows.
 */
function runInteractive(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        // ANSI escapes for Alternate Screen Buffer
        // \u001b[?1049h = Enter alt buffer
        // \u001b[H = home cursor, \u001b[2J = clear screen
        if (options.newWindow) {
            process.stdout.write('\u001b[?1049h\u001b[H\u001b[2J');
        }

        const proc = spawn(command, args, {
            stdio: 'inherit',
            shell: true,
            env: {
                ...process.env,
                NO_BROWSER: 'true',
                GEMINI_CLI_NO_RELAUNCH: 'true',
                GOOGLE_GENAI_USE_GCA: 'true', // Triggers OAuth in non-interactive/headless mode
                CI: 'true', // Bypasses folder trust prompt
                ...options.env
            },
            ...options
        });

        proc.on('close', (code) => {
            if (options.newWindow) {
                // \u001b[?1049l = Exit alt buffer (restores previous screen)
                process.stdout.write('\u001b[?1049l');
            }
            if (code === 0 || code === 199) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });

        proc.on('error', (err) => {
            if (options.newWindow) {
                process.stdout.write('\u001b[?1049l');
            }
            reject(err);
        });
    });
}

async function setupEnvAndAuth(isNative, composeCmd) {
    const envPath = path.join(process.cwd(), '.env');

    // Generate a high-entropy unique API key for the bridge
    const ionoKey = `iono_sk_${randomBytes(24).toString('hex')}`;

    if (fs.existsSync(envPath)) {
        console.log(`✅ .env file already exists at ${envPath}.`);

        const { overwrite } = await inquirer.prompt([{
            type: 'confirm',
            name: 'overwrite',
            message: 'Do you want to overwrite it?',
            default: false
        }]);

        if (!overwrite) {
            const currentEnv = fs.readFileSync(envPath, 'utf-8');
            const match = currentEnv.match(/^API_KEY=(.*)$/m);
            return match ? match[1] : undefined;
        }
    }

    console.log("\n--- Authentication Configuration ---");
    console.log("Ionosphere supports Google OAuth (via Gemini CLI) or a Gemini API Key.");

    const { authMethod } = await inquirer.prompt([{
        type: 'select',
        name: 'authMethod',
        message: 'Select Authentication Method:',
        choices: [
            { name: 'Google OAuth (Recommended)', value: 'oauth' },
            { name: 'Gemini API Key (AI Studio)', value: 'apikey' }
        ]
    }]);

    let authEnv = {};
    if (authMethod === 'oauth') {
        process.env.GEMINI_AUTH_TYPE = 'oauth-personal';
        process.env.GOOGLE_GENAI_USE_GCA = 'true';
        authEnv = {
            GEMINI_AUTH_TYPE: 'oauth-personal',
            GOOGLE_GENAI_USE_GCA: 'true'
        };
    } else {
        const { apiKey } = await inquirer.prompt([{
            type: 'input',
            name: 'apiKey',
            message: 'Enter your Gemini API Key (from AI Studio):',
            validate: (input) => input.length > 0 ? true : 'API Key is required'
        }]);
        process.env.GEMINI_API_KEY = apiKey;
        process.env.GEMINI_AUTH_TYPE = 'gemini-api-key';
        authEnv = {
            GEMINI_API_KEY: apiKey,
            GEMINI_AUTH_TYPE: 'gemini-api-key'
        };
    }

    if (isNative) {
        const hasGemini = spawnSync('gemini', ['--version'], { encoding: 'utf-8' });
        if (hasGemini.error) {
            console.error("\n❌ `gemini` is not installed on your host machine. Please install it with `npm install -g @google/gemini-cli`.");
            process.exit(1);
        } else {
            console.log("\n`gemini` is installed locally. Triggering Native validation flow...");
            if (authMethod === 'oauth') {
                console.log("NOTE: Automatic browser launch is DISABLED for stability.");
                console.log("Please copy the URL provided below into your browser, then PASTE the code back here.");
                console.log("Once authenticated, the installer will continue automatically.\n");
            }

            // Use a simple prompt to trigger auth and exit immediately
            await runInteractive('gemini', ['-p', '"ping"', '--output-format', 'text'], { newWindow: true, env: authEnv });
        }
    } else {
        console.log("\nContainer mode selected. Building Image...");
        // Pass build args to ensure Scorched Earth hardening is applied during image build
        const buildArgs = `--build-arg GEMINI_DISABLE_TOOLS=${process.env.GEMINI_DISABLE_TOOLS || 'false'} --build-arg GEMINI_DISABLE_WEB_SEARCH=${process.env.GEMINI_DISABLE_WEB_SEARCH || 'false'}`;
        spawnSync(`${composeCmd} build ${buildArgs}`, { stdio: 'inherit', shell: true });

        if (authMethod === 'oauth') {
            console.log("\n✅ Image successfully built.\n");
        } else {
            console.log("\n✅ API Key injected into the container environment.\n");
        }
    }

    return { ionoKey, needsManualAuth: !isNative && authMethod === 'oauth' };
}

async function setupPreferences() {
    console.log("\n--- Settings Configuration ---");

    const answers = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'telemetry',
            message: 'Disable telemetry?',
            default: true
        },
        {
            type: 'confirm',
            name: 'preview',
            message: 'Enable preview models?',
            default: true
        }
    ]);

    process.env.GEMINI_DISABLE_TELEMETRY = answers.telemetry ? 'true' : 'false';
    process.env.GEMINI_ENABLE_PREVIEW = answers.preview ? 'true' : 'false';

    console.log("\nGemini CLI's inbuilt tools may conflict with Ionosphere's tool bridge (custom tools).");
    console.log("\nYou can disable the inbuilt tools so that only your program's tools are used.");
    console.log("\n You can also opt to keep the google_web_search tool enabled, which has generous limits on free Google search usage.");

    const { tools } = await inquirer.prompt([{
        type: 'confirm',
        name: 'tools',
        message: "Disable Gemini's inbuilt tools?",
        default: true
    }]);

    process.env.GEMINI_DISABLE_TOOLS = tools ? 'true' : 'false';

    const { search } = await inquirer.prompt([{
        type: 'confirm',
        name: 'search',
        message: 'Disable Google Web Search tool as well?',
        default: false
    }]);

    process.env.GEMINI_DISABLE_WEB_SEARCH = search ? 'true' : 'false';
    
    console.log("\nSilent fallbacks allow Ionosphere to automatically switch to the next available model if the current model fails.");
    console.log("\nFor example, for auto-gemini-3, it goes through gemini-3-pro-preview -> gemini-3-flash-preview -> gemini-2.5-pro -> gemini-2.5-flash -> gemini-2.5-flash-lite.");

    const { silentFallback } = await inquirer.prompt([{
        type: 'confirm',
        name: 'silentFallback',
        message: 'Enable silent fallbacks to next available model? (for auto-gemini-3 or auto-gemini-2.5)',
        default: true
    }]);

    process.env.GEMINI_SILENT_FALLBACK = silentFallback ? 'true' : 'false';
}

async function generateSettings() {
    console.log("\n--- Generating Settings Block list ---");
    // Pass the populated environment variables over to generate_settings.js
    spawnSync('node', ['scripts/generate_settings.js'], {
        stdio: 'inherit',
        env: process.env
    });
}

async function applySelectiveBlindness() {
    console.log("\n--- Triggering Dynamic Tool Hardening (Selective Blindness) ---");
    spawnSync('node', ['scripts/patch-gemini-core.js'], {
        stdio: 'inherit',
        env: process.env
    });
}

async function main() {
    console.log("=========================================");
    console.log("🚀 Ionosphere Native Orchestrator Setup");
    console.log("=========================================\n");

    try {
        if (fs.existsSync(path.join(process.cwd(), '.env'))) {
            console.log("--- Maintenance Option ---");
            console.log("An existing .env was detected.");

            const { maintenance } = await inquirer.prompt([{
                type: 'confirm',
                name: 'maintenance',
                message: 'Would you like to enter the Maintenance Menu?',
                default: false
            }]);

            if (maintenance) {
                const { mChoice } = await inquirer.prompt([{
                    type: 'select',
                    name: 'mChoice',
                    message: 'Select Choice',
                    choices: [
                        { name: 'Recover/View existing API Key', value: '1' },
                        { name: 'Fresh Build (Nuke containers, volumes, and images)', value: '2' },
                        { name: 'Back to Main Setup', value: '3' }
                    ]
                }]);

                if (mChoice === '1') {
                    const currentEnv = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
                    const match = currentEnv.match(/^API_KEY=(.*)$/m);
                    if (match) {
                        console.log("\n🔑 YOUR CURRENT IONOSPHERE API KEY:");
                        console.log(`   ${match[1]}\n`);
                    } else {
                        console.log("❌ API_KEY not found in .env.");
                    }
                    return;
                }

                if (mChoice === '2') {
                    console.log("\n🧨 Nuking current container state...");
                    // Try to detect compose command
                    const dockerStatus = spawnSync('docker', ['--version']);
                    const podmanStatus = spawnSync('podman', ['--version']);
                    let cCmd = dockerStatus.error ? 'podman compose' : 'docker-compose';
                    if (!podmanStatus.error && spawnSync('podman-compose', ['--version']).status === 0) cCmd = 'podman-compose';

                    const nukeArgs = cCmd === 'podman-compose' ? ['down', '--volumes'] : ['down', '--volumes', '--rmi', 'all'];
                    const nukeResult = spawnSync(cCmd, nukeArgs, { stdio: 'inherit', shell: true });
                    if (nukeResult.status === 0) {
                        console.log("✅ State purged. Proceeding with fresh setup...\n");
                    } else {
                        console.error(`\n❌ Failed to purge current container state (Exit code: ${nukeResult.status}).`);
                        console.warn("  (Hint: If using Podman on Windows, ensure your Podman Machine is running: `podman machine start`)");
                        console.log("Proceeding with setup anyway...\n");
                    }
                }
                // Option 3 just continues to standard flow
            }
        }

        await checkTermsOfService();
        await checkDependencies();

        console.log("\n--- Setup Environment ---");

        const { envChoice } = await inquirer.prompt([{
            type: 'select',
            name: 'envChoice',
            message: 'How will you run Ionosphere?',
            choices: [
                { name: 'Native (Node.js) - NOT RECOMMENDED for production', value: '1' },
                { name: 'Docker', value: '2' },
                { name: 'Podman', value: '3' }
            ],
            default: 0
        }]);

        const isNative = envChoice === '1';
        const isDocker = envChoice === '2';
        const isPodman = envChoice === '3';

        let composeCmd = '';
        if (isDocker) composeCmd = 'docker-compose';
        if (isPodman) {
            const hasPodmanCompose = !spawnSync('podman-compose', ['--version'], { encoding: 'utf-8' }).error;
            composeCmd = hasPodmanCompose ? 'podman-compose' : 'podman compose';
        }

        // ── Multi-Instance Option (Docker/Podman only) ──
        if (!isNative) {
            const { instanceMode } = await inquirer.prompt([{
                type: 'select',
                name: 'instanceMode',
                message: 'Instance mode:',
                choices: [
                    { name: 'Single Instance — one container, one port, one auth', value: 'single' },
                    { name: 'Multi-Instance — N parallel containers, each with its own auth & port', value: 'multi' }
                ],
                default: 0
            }]);

            if (instanceMode === 'multi') {
                console.log("\n🔀 Handing off to Multi-Instance Setup...\n");
                // Dynamically import and run the multi-instance setup script
                const { main: runMultiSetup } = await import('./setup-multi.js');
                await runMultiSetup();
                return;
            }
        }

        // Collect preferences BEFORE build/auth to ensure the container image is consistent
        await setupPreferences();

        const { ionoKey, needsManualAuth } = await setupEnvAndAuth(isNative, composeCmd);
        await generateSettings();

        // Persist all captured preferences to the .env file
        const envPath = path.join(process.cwd(), '.env');
        const envContent = [
            `GEMINI_CLI_PATH=gemini`,
            `GEMINI_SETTINGS_JSON=./settings.json`,
            `GEMINI_AUTH_TYPE=${process.env.GEMINI_AUTH_TYPE}`,
            process.env.GOOGLE_GENAI_USE_GCA ? `GOOGLE_GENAI_USE_GCA=true` : '',
            process.env.GEMINI_API_KEY ? `GEMINI_API_KEY=${process.env.GEMINI_API_KEY}` : '',
            `API_KEY=${ionoKey}`,
            `GEMINI_DISABLE_TELEMETRY=${process.env.GEMINI_DISABLE_TELEMETRY}`,
            `GEMINI_ENABLE_PREVIEW=${process.env.GEMINI_ENABLE_PREVIEW}`,
            `GEMINI_DISABLE_TOOLS=${process.env.GEMINI_DISABLE_TOOLS}`,
            `GEMINI_DISABLE_WEB_SEARCH=${process.env.GEMINI_DISABLE_WEB_SEARCH}`,
            `GEMINI_SILENT_FALLBACK=${process.env.GEMINI_SILENT_FALLBACK}`,
            `GEMINI_HARDENED=true`,
            `IONOSPHERE_RAW_TOOL_NAMES=true`
        ].join('\n') + '\n';

        fs.writeFileSync(envPath, envContent, 'utf-8');
        console.log("✅ Finalized .env file with all preferences.");

        // Apply hardening patch
        await applySelectiveBlindness();

        console.log("\n=========================================");
        console.log("🎉 Setup Complete!");
        console.log("=========================================\n");

        if (ionoKey) {
            console.log("🔑 YOUR IONOSPHERE API KEY:");
            console.log(`   ${ionoKey}`);
            console.log("\nCopy this key into your AI applications (any OpenAI-compatible SDK or client)\n");
        }

        const printAuthNote = (context = 'running') => {
            if (needsManualAuth) {
                console.log("\n⚠️ IMPORTANT: Container Authentication Required ⚠️");
                console.log(`Because you selected OAuth, you MUST authenticate the ${context} container manually before using it.`);
                console.log("Open a NEW terminal window and run the following command:");
                console.log(`\n    ${isDocker ? 'docker' : 'podman'} exec -it -e CI=false ionosphere bash -c "trap 'stty sane' EXIT; gemini auth login"\n`);
                console.log("This will provide an authorization link for you to sign in. Once done, you can use Ionosphere!\n");
            }
        };

        const { startNow } = await inquirer.prompt([{
            type: 'confirm',
            name: 'startNow',
            message: 'Start the server now?',
            default: false
        }]);

        if (startNow) {
            console.log(`\n🚀 Starting the Ionosphere server...`);

            // Start the server
            if (isNative) {
                console.log(`\n🚀 Starting the Ionosphere server...\n`);
                spawnSync('npm start', { stdio: 'inherit', shell: true });
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
                                console.log(`📝 To view logs, run: ${composeCmd} logs -f`);
                                printAuthNote();
                                process.exit(0);
                            } else {
                                console.error(`\n❌ Failed to launch containers (Exit code: ${upCode}).`);
                                process.exit(upCode);
                            }
                        });
                    } else {
                        console.error(`\n❌ Build failed (Exit code: ${code}). Please check the errors above.`);
                        process.exit(code);
                    }
                });
            }
        } else {
            console.log(`\n✅ Setup complete! You can start the server later by running:`);
            console.log(`   ${isNative ? 'npm start' : `${composeCmd} up -d`}`);
            if (needsManualAuth) printAuthNote('fully started');
        }

    } catch (err) {
        console.error("Setup failed:", err);
        process.exit(1);
    }
}

main();
