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

// Special stubs for tools that export helper functions required by the CLI core
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

function nukeTool(fileName) {
    const filePath = path.join(toolsDir, fileName);

    if (PROTECTED_TOOLS.includes(fileName)) {
        console.log(`[SAFE] Skipping protected tool: ${fileName}`);
        return;
    }

    if (!fs.existsSync(filePath)) {
        console.warn(`[SKIP] File not found (already gone or not installed): ${fileName}`);
        return;
    }

    const toolName = fileName.replace('.js', '');
    const className = toolName.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('') + 'Tool';

    let stubContent = `
/**
 * [NUKE] This tool has been deactivated for security hardening by Ionosphere.
 * It has been replaced by a stub to prevent hallucination loops and ensure 
 * that only Ionosphere-vetted tools are used.
 */
export class ${className} {
    static Name = "${toolName.replace('-', '_')}";
    static name = "${className}";
    constructor() {
        throw new Error("[SECURITY] This native tool has been DELETED by the Ionosphere Hardening Protocol. Use ionosphere__ tools instead.");
    }
    async run() {
        throw new Error("[SECURITY] This native tool has been DELETED by the Ionosphere Hardening Protocol.");
    }
    getDefinition() {
        return { name: "${toolName.replace('-', '_')}", description: "DEACTIVATED FOR SECURITY" };
    }
}
`;

    // Append special stubs if needed to satisfy core dependencies
    if (SPECIAL_STUBS[fileName]) {
        stubContent += SPECIAL_STUBS[fileName];
    }

    try {
        fs.writeFileSync(filePath, stubContent, 'utf-8');
        console.log(`[NUKE] Successfully stubbed: ${fileName}`);
    } catch (err) {
        console.error(`[NUKE] Error stubbing ${fileName}:`, err);
    }
}

console.log("=========================================");
console.log("🧨 Ionosphere Scorched Earth: Refined Tool Deletion");
console.log(`   Config: DISABLE_TOOLS=${process.env.GEMINI_DISABLE_TOOLS}`);
console.log(`   Config: DISABLE_WEB_SEARCH=${process.env.GEMINI_DISABLE_WEB_SEARCH}`);
console.log("=========================================\n");

if (!fs.existsSync(toolsDir)) {
    console.error(`❌ tools directory not found: ${toolsDir}`);
    process.exit(1);
}

// 1. Nuke Inbuilt Tools if requested
if (process.env.GEMINI_DISABLE_TOOLS === 'true') {
    console.log("-> Nuking Inbuilt Filesystem/Shell Tools...");
    INBUILT_TOOLS.forEach(nukeTool);
}

// 2. Nuke Search Tools if requested
if (process.env.GEMINI_DISABLE_WEB_SEARCH === 'true') {
    console.log("-> Nuking Web Search Tools...");
    SEARCH_TOOLS.forEach(nukeTool);
}

console.log("\n✅ Tool deletion protocol complete.");
