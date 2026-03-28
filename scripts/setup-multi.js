import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_PORT = 3001; // First instance starts here (main instance stays on 3000)
const COMPOSE_OUTPUT = 'docker-compose.multi.yml';
const ENV_PREFIX = '.env.instance-';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateApiKey() {
    return `iono_sk_${randomBytes(24).toString('hex')}`;
}

function detectComposeCmd() {
    const dockerStatus = spawnSync('docker', ['--version']);
    const podmanStatus = spawnSync('podman', ['--version']);

    if (!dockerStatus.error) {
        // Check for 'docker compose' (v2 plugin) first
        const composeV2 = spawnSync('docker', ['compose', 'version']);
        if (!composeV2.error && composeV2.status === 0) return 'docker compose';
        return 'docker-compose';
    }
    if (!podmanStatus.error) {
        const hasPodmanCompose = !spawnSync('podman-compose', ['--version']).error;
        return hasPodmanCompose ? 'podman-compose' : 'podman compose';
    }
    return null;
}

/**
 * Run a command interactively (inherits stdio for OAuth flows).
 */
function runInteractive(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            stdio: 'inherit',
            shell: true,
            env: {
                ...process.env,
                NO_BROWSER: 'true',
                GEMINI_CLI_NO_RELAUNCH: 'true',
                GOOGLE_GENAI_USE_GCA: 'true',
                CI: 'true',
                ...options.env
            },
            ...options
        });

        proc.on('close', (code) => {
            if (code === 0 || code === 199) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });

        proc.on('error', (err) => reject(err));
    });
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function collectInstances() {
    const { count } = await inquirer.prompt([{
        type: 'number',
        name: 'count',
        message: 'How many parallel Ionosphere instances do you want?',
        default: 2,
        validate: (v) => v >= 1 && v <= 20 ? true : 'Enter a number between 1 and 20'
    }]);

    const instances = [];

    for (let i = 1; i <= count; i++) {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`  📡 Configuring Instance ${i} of ${count}`);
        console.log(`${'─'.repeat(50)}`);

        const { name } = await inquirer.prompt([{
            type: 'input',
            name: 'name',
            message: `Instance ${i} — Give it a name (lowercase, no spaces):`,
            default: i === 1 ? 'default' : `instance-${i}`,
            validate: (v) => {
                if (!v.match(/^[a-z0-9][a-z0-9-]*$/)) return 'Use lowercase letters, numbers, and hyphens only.';
                if (instances.some(inst => inst.name === v)) return 'Name already used.';
                return true;
            }
        }]);

        const { authMethod } = await inquirer.prompt([{
            type: 'list',
            name: 'authMethod',
            message: `[${name}] Authentication method:`,
            choices: [
                { name: 'Google OAuth (personal Google account)', value: 'oauth' },
                { name: 'Gemini API Key (AI Studio)', value: 'apikey' }
            ]
        }]);

        let apiKey = '';
        if (authMethod === 'apikey') {
            const { key } = await inquirer.prompt([{
                type: 'input',
                name: 'key',
                message: `[${name}] Enter your Gemini API Key:`,
                validate: (v) => v.length > 0 ? true : 'API Key is required'
            }]);
            apiKey = key;
        }

        const { port } = await inquirer.prompt([{
            type: 'number',
            name: 'port',
            message: `[${name}] Host port bound for this instance:`,
            default: BASE_PORT + (i - 1),
            validate: (v) => {
                if (v < 1024 || v > 65535) return 'Port must be between 1024 and 65535';
                if (instances.some(inst => inst.port === v)) return 'Port already assigned to another instance in this setup';
                return true;
            }
        }]);

        const { maxCli } = await inquirer.prompt([{
            type: 'number',
            name: 'maxCli',
            message: `[${name}] Max concurrent CLI processes for this instance:`,
            default: 5,
            validate: (v) => v >= 1 && v <= 50 ? true : 'Enter a number between 1 and 50'
        }]);

        instances.push({
            name,
            index: i,
            port,
            authMethod,
            apiKey,
            maxCli,
            bridgeKey: generateApiKey(),
        });
    }

    return instances;
}

function generateEnvFile(instance, globalPrefs) {
    const lines = [
        `# Ionosphere Instance: ${instance.name}`,
        `# Generated: ${new Date().toISOString()}`,
        ``,
        `# --- Bridge Auth ---`,
        `API_KEY=${instance.bridgeKey}`,
        `PORT=${instance.port}`,
        `MAX_CONCURRENT_CLI=${instance.maxCli}`,
        ``,
        `# --- Google Auth ---`,
        `GEMINI_AUTH_TYPE=${instance.authMethod === 'oauth' ? 'oauth-personal' : 'gemini-api-key'}`,
    ];

    if (instance.authMethod === 'oauth') {
        lines.push(`GOOGLE_GENAI_USE_GCA=true`);
    }

    if (instance.apiKey) {
        lines.push(`GEMINI_API_KEY=${instance.apiKey}`);
    }

    lines.push(
        ``,
        `# --- CLI Config ---`,
        `GEMINI_CLI_PATH=gemini`,
        `GEMINI_SETTINGS_JSON=/app/settings.json`,
        `GEMINI_HARDENED=true`,
        `GEMINI_DISABLE_TELEMETRY=${globalPrefs.disableTelemetry ? 'true' : 'false'}`,
        `GEMINI_ENABLE_PREVIEW=${globalPrefs.enablePreview ? 'true' : 'false'}`,
        `GEMINI_DISABLE_TOOLS=${globalPrefs.disableTools ? 'true' : 'false'}`,
        `GEMINI_DISABLE_WEB_SEARCH=${globalPrefs.disableWebSearch ? 'true' : 'false'}`,
        `GEMINI_SILENT_FALLBACK=${globalPrefs.silentFallback ? 'true' : 'false'}`,
        ``,
        `# --- Runtime ---`,
        `GEMINI_MAX_TURNS=50`,
        `WARM_HANDOFF_ENABLED=true`,
        `CI=true`,
        `NO_BROWSER=true`,
        `GEMINI_CLI_NO_RELAUNCH=true`,
        ``
    );

    return lines.join('\n');
}

function generateComposeFile(instances) {
    // Build the YAML manually to keep it clean and readable
    const lines = [
        `# Ionosphere Multi-Instance Compose File`,
        `# Generated: ${new Date().toISOString()}`,
        `# Instances: ${instances.map(i => i.name).join(', ')}`,
        `#`,
        `# Usage:`,
        `#   docker compose -f docker-compose.multi.yml up -d --build`,
        `#   docker compose -f docker-compose.multi.yml logs -f`,
        `#   docker compose -f docker-compose.multi.yml down`,
        ``,
        `version: "3.8"`,
        ``,
        `services:`,
    ];

    for (const inst of instances) {
        const serviceName = `ionosphere-${inst.name}`;
        const envFile = `${ENV_PREFIX}${inst.name}`;
        const volumeName = `gemini-config-${inst.name}`;
        const tempDir = `./temp/${inst.name}`;

        lines.push(
            ``,
            `  ${serviceName}:`,
            `    build:`,
            `      context: .`,
            `      args:`,
            `        - GEMINI_DISABLE_TOOLS=\${GEMINI_DISABLE_TOOLS:-false}`,
            `        - GEMINI_DISABLE_WEB_SEARCH=\${GEMINI_DISABLE_WEB_SEARCH:-false}`,
            `    container_name: ${serviceName}`,
            `    restart: unless-stopped`,
            `    tty: true`,
            `    stdin_open: true`,
            `    env_file:`,
            `      - ${envFile}`,
            `    command: node src/index.js`,
            `    ports:`,
            `      - "${inst.port}:${inst.port}"`,
            `    volumes:`,
            `      - ${volumeName}:/root/.gemini`,
            `      - ${tempDir}:/app/temp`,
        );
    }

    lines.push(``, `volumes:`);
    for (const inst of instances) {
        lines.push(`  gemini-config-${inst.name}:`);
    }
    lines.push(``);

    return lines.join('\n');
}

async function runOAuthFlows(instances, composeCmd) {
    const oauthInstances = instances.filter(i => i.authMethod === 'oauth');
    if (oauthInstances.length === 0) return;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🔐 OAuth Authentication (${oauthInstances.length} instance${oauthInstances.length > 1 ? 's' : ''})`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\nEach OAuth instance needs to authenticate with a Google account.`);
    console.log(`The Gemini CLI will provide a URL — open it in your browser,`);
    console.log(`sign in, and paste the authorization code back here.\n`);

    console.log(`\n⚠️ IMPORTANT: Manual OAuth Authentication Required ⚠️`);
    console.log(`For each of the following instances, open a NEW terminal window and run its command.`);
    console.log(`This will present you with the login URL. Sign in and the credentials will be saved.\n`);

    for (const inst of oauthInstances) {
        const serviceName = `ionosphere-${inst.name}`;
        console.log(`To authenticate ${inst.name}:`);
        const engine = composeCmd.includes('docker') ? 'docker' : 'podman';
        console.log(`  ${engine} exec -it -e CI=false ${serviceName} bash -c "trap 'stty sane' EXIT; gemini auth login"`);
    }
    console.log(`\nOnce you have authenticated all required instances, you can start the application.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`${'═'.repeat(60)}`);
    console.log(`  🚀 Ionosphere Multi-Instance Setup`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\nThis tool generates a Docker Compose file and per-instance`);
    console.log(`environment configs for running multiple Ionosphere sessions`);
    console.log(`in parallel — each with its own auth, port, and workspace.\n`);

    // ── Check for existing multi-instance config ──
    if (fs.existsSync(COMPOSE_OUTPUT)) {
        const { overwrite } = await inquirer.prompt([{
            type: 'confirm',
            name: 'overwrite',
            message: `${COMPOSE_OUTPUT} already exists. Overwrite?`,
            default: false
        }]);

        if (!overwrite) {
            console.log('Aborted. Existing configuration preserved.');
            return;
        }
    }

    // ── Detect container runtime ──
    const composeCmd = detectComposeCmd();
    if (!composeCmd) {
        console.error('❌ Neither Docker nor Podman detected. Install one to use multi-instance mode.');
        process.exit(1);
    }
    console.log(`✅ Container runtime: ${composeCmd}\n`);

    // ── Collect global preferences ──
    console.log(`${'─'.repeat(50)}`);
    console.log(`  ⚙️  Global Preferences (shared across all instances)`);
    console.log(`${'─'.repeat(50)}\n`);

    const globalPrefs = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'disableTelemetry',
            message: 'Disable telemetry?',
            default: true
        },
        {
            type: 'confirm',
            name: 'enablePreview',
            message: 'Enable preview models?',
            default: true
        },
        {
            type: 'confirm',
            name: 'disableTools',
            message: "Disable Gemini's inbuilt tools? (recommended for custom tool workflows)",
            default: true
        },
        {
            type: 'confirm',
            name: 'disableWebSearch',
            message: 'Disable Google Web Search tool as well?',
            default: false
        },
        {
            type: 'confirm',
            name: 'silentFallback',
            message: 'Enable silent model fallbacks? (auto-switch on model failure)',
            default: true
        }
    ]);

    // ── Collect per-instance configs ──
    const instances = await collectInstances();

    // ── Generate files ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  📝 Generating Configuration Files`);
    console.log(`${'═'.repeat(60)}\n`);

    // Write per-instance .env files
    for (const inst of instances) {
        const envPath = `${ENV_PREFIX}${inst.name}`;
        const envContent = generateEnvFile(inst, globalPrefs);
        fs.writeFileSync(envPath, envContent, 'utf-8');
        console.log(`  ✅ ${envPath}`);
    }

    // Write docker-compose.multi.yml
    const composeContent = generateComposeFile(instances);
    fs.writeFileSync(COMPOSE_OUTPUT, composeContent, 'utf-8');
    console.log(`  ✅ ${COMPOSE_OUTPUT}`);

    // Create temp directories
    for (const inst of instances) {
        const tempDir = path.join('temp', inst.name);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    }
    console.log(`  ✅ temp/ subdirectories`);

    // ── Add to .gitignore ──
    const gitignorePath = '.gitignore';
    if (fs.existsSync(gitignorePath)) {
        let gitignore = fs.readFileSync(gitignorePath, 'utf-8');
        const additions = [];
        if (!gitignore.includes('.env.instance-')) additions.push('.env.instance-*');
        if (!gitignore.includes('docker-compose.multi.yml')) additions.push('docker-compose.multi.yml');

        if (additions.length > 0) {
            gitignore += `\n# Multi-instance generated files\n${additions.join('\n')}\n`;
            fs.writeFileSync(gitignorePath, gitignore, 'utf-8');
            console.log(`  ✅ .gitignore updated`);
        }
    }

    // ── Build the image ──
    const { buildNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'buildNow',
        message: 'Build the Docker image now?',
        default: true
    }]);

    if (buildNow) {
        console.log(`\n🏗️  Building Ionosphere image...`);
        console.log(`⏳ (This may take a few minutes for the first build)\n`);

        const buildArgs = `--build-arg GEMINI_DISABLE_TOOLS=${globalPrefs.disableTools ? 'true' : 'false'} --build-arg GEMINI_DISABLE_WEB_SEARCH=${globalPrefs.disableWebSearch ? 'true' : 'false'}`;
        const buildResult = spawnSync(`${composeCmd} -f ${COMPOSE_OUTPUT} build ${buildArgs}`, {
            stdio: 'inherit',
            shell: true
        });

        if (buildResult.status !== 0) {
            console.error(`\n❌ Build failed. Fix the errors above and re-run.`);
            process.exit(1);
        }
        console.log(`✅ Image built successfully.\n`);
    }

    // ── Summary ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🎉 Multi-Instance Setup Complete!`);
    console.log(`${'═'.repeat(60)}\n`);

    // Summary table
    const maxNameLen = Math.max(...instances.map(i => i.name.length), 4);
    const header = `  ${'Name'.padEnd(maxNameLen)}  Port   Auth       API Key (Bridge)`;
    const divider = `  ${'─'.repeat(maxNameLen)}  ${'─'.repeat(5)}  ${'─'.repeat(9)}  ${'─'.repeat(52)}`;

    console.log(header);
    console.log(divider);

    for (const inst of instances) {
        const auth = inst.authMethod === 'oauth' ? 'OAuth' : 'API Key';
        console.log(`  ${inst.name.padEnd(maxNameLen)}  ${String(inst.port).padEnd(5)}  ${auth.padEnd(9)}  ${inst.bridgeKey}`);
    }

    console.log(`\n📋 Quick Reference:\n`);
    console.log(`  Start all:   ${composeCmd} -f ${COMPOSE_OUTPUT} up -d`);
    console.log(`  View logs:   ${composeCmd} -f ${COMPOSE_OUTPUT} logs -f`);
    console.log(`  Stop all:    ${composeCmd} -f ${COMPOSE_OUTPUT} down`);
    console.log(`  Restart one: ${composeCmd} -f ${COMPOSE_OUTPUT} restart ionosphere-<name>`);
    console.log(``);

    for (const inst of instances) {
        console.log(`  📡 ${inst.name}: http://localhost:${inst.port}/v1/chat/completions`);
    }

    console.log(`\n💡 Use these endpoints in your OpenAI-compatible clients.`);
    console.log(`   Each instance's Bridge API Key is in its .env.instance-<name> file.\n`);

    // ── Offer to start ──
    const { startNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'startNow',
        message: 'Launch all instances now?',
        default: false
    }]);

    if (startNow) {
        console.log(`\n🚀 Launching ${instances.length} instance(s)...\n`);
        const upResult = spawnSync(`${composeCmd} -f ${COMPOSE_OUTPUT} up -d`, {
            stdio: 'inherit',
            shell: true
        });

        if (upResult.status === 0) {
            console.log(`\n✅ All instances are running!`);
            console.log(`📝 View logs: ${composeCmd} -f ${COMPOSE_OUTPUT} logs -f\n`);
            
            if (buildNow) {
                // ── Run OAuth flows now that containers exist ──
                await runOAuthFlows(instances, composeCmd);
            }
        } else {
            console.error(`\n❌ Failed to launch. Check the errors above.`);
        }
    } else {
        if (buildNow) {
            console.log(`\n✅ Setup complete! You can start the instances later by running:`);
            console.log(`   ${composeCmd} -f ${COMPOSE_OUTPUT} up -d`);
            // Instruct user they still need to auth when they start them
            await runOAuthFlows(instances, composeCmd);
        }
    }
}
export { main };

// Auto-run when executed directly (not imported)
const isDirectRun = process.argv[1] &&
    (process.argv[1].endsWith('setup-multi.js') ||
     process.argv[1].endsWith('setup-multi'));

if (isDirectRun) {
    main().catch(err => {
        console.error('Setup failed:', err);
        process.exit(1);
    });
}
