import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// toolsDir calculation
const toolsDir = path.join(__dirname, '..', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'tools');

// Tool mappings
const INBUILT_TOOLS = [
    'read-file.js',
    'write-file.js',
    'grep.js',
    'ripGrep.js',
    'glob.js',
    'ls.js',
    'shell.js',
    'edit.js',
    'activate-skill.js',
    'memoryTool.js',
    'write-todos.js',
    'get-internal-docs.js'
];

const SEARCH_TOOLS = [
    'web-search.js',
    'web-fetch.js'
];

// CRITICAL PROTECTION: Never nuke read_many_files.js as it's used for broad context ingestion.
const PROTECTED_TOOLS = [
    'read-many-files.js'
];

const SPECIAL_STUBS = {
    'memoryTool.js': `
export const DEFAULT_CONTEXT_FILENAME = "GEMINI.md";
export const MEMORY_SECTION_HEADER = "## Gemini Added Memories";
export function setGeminiMdFilename(f) {}
export function getCurrentGeminiMdFilename() { return DEFAULT_CONTEXT_FILENAME; }
export function getAllGeminiMdFilenames() { return [DEFAULT_CONTEXT_FILENAME]; }
export function getGlobalMemoryFilePath() { return ""; }
`,
    'shell.js': `
export const OUTPUT_UPDATE_INTERVAL_MS = 1000;
`
};

const CLASS_NAME_OVERRIDES = {
    'memoryTool.js': 'MemoryTool',
    'shell.js': 'ShellTool',
    'read-file.js': 'ReadFileTool',
    'write-file.js': 'WriteFileTool',
    'grep.js': 'GrepTool',
    'ls.js': 'LSTool'
};

const TOOL_NAME_OVERRIDES = {
    'memoryTool.js': 'save_memory',
    'shell.js': 'run_shell_command',
    'ls.js': 'list_directory',
    'grep.js': 'grep_search'
};

function nukeTool(fileName) {
    const filePath = path.join(toolsDir, fileName);

    if (PROTECTED_TOOLS.includes(fileName)) {
        console.log(`[SAFE] Skipping protected tool: ${fileName}`);
        return;
    }

    if (!fs.existsSync(filePath)) {
        console.warn(`[SKIP] File not found: ${fileName}`);
        return;
    }

    const toolName = fileName.replace('.js', '');
    const finalToolName = TOOL_NAME_OVERRIDES[fileName] || toolName.replace('-', '_');
    const className = CLASS_NAME_OVERRIDES[fileName] || (toolName.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('') + 'Tool');

    console.log(`[NUKE] Hardening ${fileName} (Class: ${className}, Name: ${finalToolName})`);

    let stubContent = `
/**
 * [NUKE] This tool has been deactivated for security hardening by Ionosphere.
 */
export class ${className} {
    static Name = "${finalToolName}";
    static name = "${className}";
    constructor() {
        throw new Error("[SECURITY] This native tool has been DELETED by the Ionosphere Hardening Protocol.");
    }
    async run() {
        throw new Error("[SECURITY] This native tool has been DELETED by the Ionosphere Hardening Protocol.");
    }
    getDefinition() {
        return { name: "${finalToolName}", description: "DEACTIVATED FOR SECURITY" };
    }
}
`;

    if (SPECIAL_STUBS[fileName]) {
        console.log(`[NUKE] Appending surgical exports to ${fileName}`);
        stubContent += SPECIAL_STUBS[fileName];
    }

    try {
        fs.writeFileSync(filePath, stubContent, 'utf-8');
    } catch (err) {
        console.error(`[NUKE] Error writing ${fileName}:`, err);
    }
}

console.log("=========================================");
console.log("🧨 Ionosphere Scorched Earth: Refined Tool Deletion");
console.log(`   Config: DISABLE_TOOLS=${process.env.GEMINI_DISABLE_TOOLS || 'false'}`);
console.log(`   Config: DISABLE_WEB_SEARCH=${process.env.GEMINI_DISABLE_WEB_SEARCH || 'false'}`);
console.log("=========================================\n");

if (!fs.existsSync(toolsDir)) {
    console.error(`❌ tools directory not found: ${toolsDir}`);
    process.exit(1);
}

const disableTools = String(process.env.GEMINI_DISABLE_TOOLS).toLowerCase() === 'true';
const disableSearch = String(process.env.GEMINI_DISABLE_WEB_SEARCH).toLowerCase() === 'true';

// 1. Nuke Inbuilt Tools if requested
if (disableTools) {
    console.log("-> Nuking Inbuilt Filesystem/Shell Tools...");
    INBUILT_TOOLS.forEach(nukeTool);
} else {
    console.log("-> Skipping Filesystem/Shell tool nuke (disabled).");
}

// 2. Nuke Search Tools if requested
if (disableSearch) {
    console.log("-> Nuking Web Search Tools...");
    SEARCH_TOOLS.forEach(nukeTool);
} else {
    console.log("-> Skipping Web Search tool nuke (disabled).");
}

console.log("\n✅ Tool deletion protocol complete.");
