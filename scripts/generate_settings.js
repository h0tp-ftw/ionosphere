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
    const { targetPath = TARGET_PATH, mcpServers = null, customSettings = null, modelName = null, generationConfig = null } = options;

    const config = {
        general: {
            previewFeatures: process.env.GEMINI_ENABLE_PREVIEW !== 'false'
        },
        privacy: {
            usageStatisticsEnabled: process.env.GEMINI_DISABLE_TELEMETRY !== 'true'
        },
        telemetry: {
            enabled: false
        },
        skills: {
            enabled: false
        },
        experimental: {
            enableAgents: false,
            previewFeatures: process.env.GEMINI_ENABLE_PREVIEW !== 'false'
        },
        model: {
            name: modelName || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
            maxSessionTurns: parseInt(process.env.GEMINI_MAX_TURNS) || 50
        },
        tools: {
            core: (() => {
                const hardened = process.env.GEMINI_HARDENED === 'true' || process.env.GEMINI_DISABLE_TOOLS === 'true';
                if (hardened) {
                    // Strictly allow only Google Search as a core tool.
                    // Everything else must come from the bridge (MCP).
                    return [
                        "google_web_search"
                    ];
                }
                return undefined;
            })(),
            exclude: (() => {
                let excludeList = [];
                const hardened = process.env.GEMINI_HARDENED === 'true' || process.env.GEMINI_DISABLE_TOOLS === 'true';
                const extraExcludes = process.env.GEMINI_EXCLUDE_TOOLS ? process.env.GEMINI_EXCLUDE_TOOLS.split(',') : [];

                if (hardened) {
                    // Exclude all known native tools to prevent conflicts with bridge aliases.
                    excludeList = [
                        "glob",
                        "grep_search",
                        "list_directory",
                        "read_file",
                        "read_many_files",
                        "run_shell_command",
                        "write_file",
                        "replace",
                        "edit",
                        "write_todos",
                        "web_fetch",
                        "save_memory",
                        "activate_skill",
                        "activate-skill",
                        "ask_user",
                        "enter_plan_mode",
                        "exit_plan_mode",
                        "get_internal_docs",
                        "codebase_investigator",
                        "cli_help",
                        "generalist",
                        "default_api"
                    ];
                }

                // Merge in extra excludes from env
                excludeList = [...new Set([...excludeList, ...extraExcludes])];

                // Legacy flags
                if (process.env.GEMINI_DISABLE_WEB_SEARCH === 'true') {
                    excludeList.push("google_web_search");
                }

                return excludeList.length > 0 ? [...new Set(excludeList)] : undefined;
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

    if (generationConfig) {
        config.modelConfigs = {
            customOverrides: [
                {
                    match: { model: config.model.name },
                    modelConfig: {
                        generateContentConfig: generationConfig
                    }
                }
            ]
        };
    }

    // Helper for deep merging custom settings onto the base config
    const isObject = (item) => item && typeof item === 'object' && !Array.isArray(item);
    const deepMerge = (target, source) => {
        if (!isObject(target) || !isObject(source)) {
            return source;
        }
        for (const key in source) {
            if (isObject(source[key])) {
                if (!target[key]) Object.assign(target, { [key]: {} });
                deepMerge(target[key], source[key]);
            } else {
                Object.assign(target, { [key]: source[key] });
            }
        }
        return target;
    };

    if (customSettings) {
        deepMerge(config, customSettings);
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
