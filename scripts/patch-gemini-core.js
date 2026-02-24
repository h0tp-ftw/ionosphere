import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetFile = path.resolve(__dirname, '..', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'availability', 'policyCatalog.js');

if (!fs.existsSync(targetFile)) {
    console.error(`[Patcher] Target file not found: ${targetFile}`);
    process.exit(0); // Exit gracefully if node_modules isn't installed yet
}

console.log(`[Patcher] Patching Gemini CLI Core: ${targetFile}`);

let content = fs.readFileSync(targetFile, 'utf8');

// 1. Force Silent Actions
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
} else {
    console.log("  - Silent Actions already applied or pattern mismatch.");
}

// 2. Customize PREVIEW_CHAIN
const previewSearch = /const PREVIEW_CHAIN = \[[\s\S]*?\];/;
const previewReplace = `const PREVIEW_CHAIN = [
    definePolicy({ model: PREVIEW_GEMINI_MODEL }),
    definePolicy({ model: PREVIEW_GEMINI_FLASH_MODEL }),
    definePolicy({ model: DEFAULT_GEMINI_MODEL }),
    definePolicy({ model: DEFAULT_GEMINI_FLASH_MODEL }),
    definePolicy({ model: DEFAULT_GEMINI_FLASH_LITE_MODEL, isLastResort: true }),
];`;

// Check if it already has 5 items to avoid double-patching
const previewMatch = content.match(previewSearch);
if (previewMatch && previewMatch[0].split('definePolicy').length < 6) {
    content = content.replace(previewSearch, previewReplace);
    console.log("  - Applied 5-Model Fallback Chain patch.");
} else {
    console.log("  - Fallback Chain already patched or pattern mismatch.");
}

fs.writeFileSync(targetFile, content, 'utf8');
console.log("[Patcher] Patching complete.");
