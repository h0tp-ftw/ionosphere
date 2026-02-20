import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'settings.json');
const TARGET_PATH = process.env.GEMINI_SETTINGS_JSON || DEFAULT_SETTINGS_PATH;

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
                    "read_file",
                    "write_file",
                    "list_files",
                    "search_files",
                    "edit_file",
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

const isDryRun = process.argv.includes('--dry-run');

if (isDryRun) {
    console.log(JSON.stringify(config, null, 2));
} else {
    const dir = path.dirname(TARGET_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TARGET_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`Successfully wrote settings to ${TARGET_PATH}`);
}
