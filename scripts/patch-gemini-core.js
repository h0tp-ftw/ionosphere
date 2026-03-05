import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');

// Simple .env parser to avoid extra dependencies
const getEnv = (key, defaultVal) => {
    if (process.env[key]) return process.env[key];
    if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, 'utf8');
        const match = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (match) return match[1].trim();
    }
    return defaultVal;
};

const disableTools = getEnv('GEMINI_DISABLE_TOOLS', 'false') === 'true';
const disableSearch = getEnv('GEMINI_DISABLE_WEB_SEARCH', 'false') === 'true';
const hardened = getEnv('GEMINI_HARDENED', 'false') === 'true';

// 1. Patch policyCatalog.js (Silent Actions & Fallbacks)
// We always apply this for Ionosphere stability
const policyCatalogFile = path.resolve(__dirname, '..', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'availability', 'policyCatalog.js');

if (fs.existsSync(policyCatalogFile)) {
    console.log(`[Patcher] Patching policyCatalog.js: ${policyCatalogFile}`);
    let content = fs.readFileSync(policyCatalogFile, 'utf8');

    // Force Silent Actions
    const silentSearch = /const DEFAULT_ACTIONS = \{[\s\S]*?\};/;
    const silentReplace = `const DEFAULT_ACTIONS = {
    terminal: 'silent',
    transient: 'silent',
    not_found: 'silent',
    unknown: 'silent',
};`;

    if (content.includes("terminal: 'prompt'")) {
        content = content.replace(silentSearch, silentReplace);
        console.log("  - Applied Silent Actions patch.");
    }

    // 1. Correct the Default 2.x Chain (3 models)
    const defaultChainSearch = /const DEFAULT_CHAIN = \[[\s\S]*?\];/;
    const defaultChainReplace = `const DEFAULT_CHAIN = [
    definePolicy({ model: DEFAULT_GEMINI_MODEL }),
    definePolicy({ model: DEFAULT_GEMINI_FLASH_MODEL }),
    definePolicy({ model: DEFAULT_GEMINI_FLASH_LITE_MODEL, isLastResort: true }),
];`;

    const defaultMatch = content.match(defaultChainSearch);
    if (defaultMatch && defaultMatch[0].split('definePolicy').length < 4) {
        content = content.replace(defaultChainSearch, defaultChainReplace);
        console.log("  - Applied 3-Model Default Chain patch.");
    }

    // 2. Correct the Preview 3.x -> 2.x Chain (5 models)
    const previewFuncSearch = /return \[[\s\S]*?definePolicy\(\{ model: previewModel \}\),[\s\S]*?definePolicy\(\{ model: PREVIEW_GEMINI_FLASH_MODEL, isLastResort: true \}\),[\s\S]*?\];/;
    const previewFuncReplace = `return [
            definePolicy({ model: previewModel }),
            definePolicy({ model: PREVIEW_GEMINI_FLASH_MODEL }),
            definePolicy({ model: DEFAULT_GEMINI_MODEL }),
            definePolicy({ model: DEFAULT_GEMINI_FLASH_MODEL }),
            definePolicy({ model: DEFAULT_GEMINI_FLASH_LITE_MODEL, isLastResort: true }),
        ];`;

    if (content.match(previewFuncSearch)) {
        content = content.replace(previewFuncSearch, previewFuncReplace);
        console.log("  - Applied 5-Model Fallback Chain patch.");
    }

    fs.writeFileSync(policyCatalogFile, content, 'utf8');
}

// 2. Patch config.js (Selective Blindness & Agent Hardening)
const configTarget = path.resolve(__dirname, '..', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'config', 'config.js');
if (fs.existsSync(configTarget)) {
    console.log(`[Patcher] Patching Config.js for Selective Blindness: ${configTarget}`);
    let configContent = fs.readFileSync(configTarget, 'utf8');

    // Filter maybeRegister to Allow List
    const maybeRegisterSearch = /const maybeRegister = \(toolClass, registerFn\) => \{[\s\S]*?\n        \};/;
    const maybeRegisterReplace = `const maybeRegister = (toolClass, registerFn) => {
            const className = toolClass.name;
            const toolName = toolClass.Name || className;
            const normalizedClassName = className.replace(/^_+/, '');

            const disableTools = process.env.GEMINI_DISABLE_TOOLS === 'true';
            const disableSearch = process.env.GEMINI_DISABLE_WEB_SEARCH === 'true';
            const hardened = process.env.GEMINI_HARDENED === 'true';

            // Essential list that is ALWAYS allowed (attachments)
            const internalAllowList = ['read_many_files'];
            
            // Search tools
            const searchTools = ['google_search', 'google_web_search'];

            let isAllowed = internalAllowList.includes(toolName) || internalAllowList.includes(normalizedClassName);
            
            if (!isAllowed) {
                if (searchTools.includes(toolName) || searchTools.includes(normalizedClassName)) {
                    isAllowed = !disableSearch;
                } else if (hardened) {
                    // [HARDENING] Strict mode: ONLY internalAllowList (and Search) are allowed.
                    isAllowed = false;
                } else {
                    // All other native tools (filesystem, etc)
                    isAllowed = !disableTools;
                }
            }
            
            if (isAllowed) {
                // Silently register
                registerFn();
            } else {
                // [HARDENING] Skip registration - the model is now blind to this native tool
            }
        };`;

    if (configContent.includes('const maybeRegister = (toolClass, registerFn) => {')) {
        configContent = configContent.replace(maybeRegisterSearch, maybeRegisterReplace);
        console.log("  - Applied Selective Blindness to native tool registration.");
    }

    // Disable native agents (Codebase Investigator, etc.)
    const subAgentCall = /this\.registerSubAgentTools\(registry\);/;
    if (configContent.match(subAgentCall)) {
        configContent = configContent.replace(subAgentCall, '// [IONOSPHERE] Disabled native agents for security\n        // this.registerSubAgentTools(registry);');
        console.log("  - Disabled native sub-agent registration.");
    }

    fs.writeFileSync(configTarget, configContent, 'utf8');
}

console.log("[Patcher] Patching complete.");
