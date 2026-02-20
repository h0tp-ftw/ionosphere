import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SETTINGS_PATH = path.join(PROJECT_ROOT, '.gemini', 'settings.json');
const TARGET_PATH = process.env.GEMINI_SETTINGS_JSON || DEFAULT_SETTINGS_PATH;

export function generateConfig(options = {}) {
    const { targetPath = TARGET_PATH, mcpServers = null } = options;

    const config = {
        general: {
            previewFeatures: process.env.GEMINI_ENABLE_PREVIEW !== 'false'
        },
        privacy: {
            usageStatisticsEnabled: process.env.GEMINI_DISABLE_TELEMETRY !== 'true'
        },
        telemetry: {
            enabled: process.env.GEMINI_DISABLE_TELEMETRY !== 'true'
        },
        model: {
            name: "gemini-2.5-flash-lite",
            maxSessionTurns: -1  // Unlimited — prevents CLI from truncating session history
        },
        tools: {
            exclude: (() => {
                const excludeList = [];
                const disableTools = process.env.GEMINI_DISABLE_TOOLS !== 'false';
                const disableSearch = process.env.GEMINI_DISABLE_WEB_SEARCH === 'true';

                if (disableTools) {
                    excludeList.push(
                        "list_directory",
                        "read_file",
                        "write_file",
                        "glob",
                        "grep_search",
                        "replace",
                        "run_shell_command"
                    );
                }
                if (disableSearch) {
                    excludeList.push("google_web_search");
                }
                return excludeList;
            })()
        }
    };

    if (process.env.GEMINI_AUTH_TYPE) {
        config.auth = {
            enforcedAuthType: process.env.GEMINI_AUTH_TYPE
        };
    }

    if (mcpServers) {
        config.mcpServers = mcpServers;
    }

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf-8');
    return config;
}

// Support running directly from CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    const isDryRun = process.argv.includes('--dry-run');
    if (isDryRun) {
        console.log(JSON.stringify(generateConfig({ targetPath: '/dev/null' }), null, 2));
    } else {
        generateConfig();
        console.log(`Successfully wrote settings to ${TARGET_PATH}`);
    }
}
