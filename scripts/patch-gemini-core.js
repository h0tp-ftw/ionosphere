import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env");

// Simple .env parser to avoid extra dependencies
const getEnv = (key, defaultVal) => {
  if (process.env[key]) return process.env[key];
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, "utf8");
    const match = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (match) return match[1].trim();
  }
  return defaultVal;
};

const disableTools = getEnv("GEMINI_DISABLE_TOOLS", "false") === "true";
const disableSearch = getEnv("GEMINI_DISABLE_WEB_SEARCH", "false") === "true";
const hardened = getEnv("GEMINI_HARDENED", "false") === "true";

// 1. Patch policyCatalog.js (Silent Actions & Fallbacks)
// We always apply this for Ionosphere stability
const policyCatalogFile = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "availability",
  "policyCatalog.js",
);

if (fs.existsSync(policyCatalogFile)) {
  console.log(`[Patcher] Patching policyCatalog.js: ${policyCatalogFile}`);
  let content = fs.readFileSync(policyCatalogFile, "utf8");

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
  if (defaultMatch && defaultMatch[0].split("definePolicy").length < 4) {
    content = content.replace(defaultChainSearch, defaultChainReplace);
    console.log("  - Applied 3-Model Default Chain patch.");
  }

  // 2. Correct the Preview 3.x -> 2.x Chain (5 models)
  const previewFuncSearch =
    /return \[[\s\S]*?definePolicy\(\{ model: previewModel \}\),[\s\S]*?definePolicy\(\{ model: PREVIEW_GEMINI_FLASH_MODEL, isLastResort: true \}\),[\s\S]*?\];/;
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

  fs.writeFileSync(policyCatalogFile, content, "utf8");
}

// 2. Patch config.js (Selective Blindness & Agent Hardening)
const configTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "config",
  "config.js",
);
if (fs.existsSync(configTarget)) {
  console.log(
    `[Patcher] Patching Config.js for Selective Blindness: ${configTarget}`,
  );
  let configContent = fs.readFileSync(configTarget, "utf8");

  // Filter maybeRegister to Allow List
  const maybeRegisterSearch =
    /const maybeRegister = \(toolClass, registerFn\) => \{[\s\S]*?\n        \};/;
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

  if (
    configContent.includes("const maybeRegister = (toolClass, registerFn) => {")
  ) {
    configContent = configContent.replace(
      maybeRegisterSearch,
      maybeRegisterReplace,
    );
    console.log("  - Applied Selective Blindness to native tool registration.");
  }

  // Disable native agents (Codebase Investigator, etc.)
  const subAgentCall = /this\.registerSubAgentTools\(registry\);/;
  if (configContent.match(subAgentCall)) {
    configContent = configContent.replace(
      subAgentCall,
      "// [IONOSPHERE] Disabled native agents for security\n        // this.registerSubAgentTools(registry);",
    );
    console.log("  - Disabled native sub-agent registration.");
  }

  fs.writeFileSync(configTarget, configContent, "utf8");
}

// 3. Patch nonInteractiveCli.js (Native History Protocol)
// When IONOSPHERE_STRUCTURED_HISTORY env var is set, stdin is parsed as JSON Content[]
// instead of flat text. This allows lossless structured data round-trip for ionosphere.
const nonInteractiveTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli",
  "dist",
  "src",
  "nonInteractiveCli.js",
);
if (fs.existsSync(nonInteractiveTarget)) {
  console.log(
    `[Patcher] Patching nonInteractiveCli.js for Native History Protocol: ${nonInteractiveTarget}`,
  );
  let niContent = fs.readFileSync(nonInteractiveTarget, "utf8");

  // Precise find-replace of the section from "Emit init event" through
  // "let currentMessages = [{ role: 'user', parts: query }];"
  // Both paths declare `currentMessages` at the same scope so the while loop below works unchanged.
  const searchBlock =
    "// Emit init event for streaming JSON\n" +
    "            if (streamFormatter) {\n" +
    "                streamFormatter.emitEvent({\n" +
    "                    type: JsonStreamEventType.INIT,\n" +
    "                    timestamp: new Date().toISOString(),\n" +
    "                    session_id: config.getSessionId(),\n" +
    "                    model: config.getModel(),\n" +
    "                });\n" +
    "            }\n" +
    "            let query;\n" +
    "            if (isSlashCommand(input)) {\n" +
    "                const slashCommandResult = await handleSlashCommand(input, abortController, config, settings);\n" +
    "                // If a slash command is found and returns a prompt, use it.\n" +
    "                // Otherwise, slashCommandResult falls through to the default prompt\n" +
    "                // handling.\n" +
    "                if (slashCommandResult) {\n" +
    "                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion\n" +
    "                    query = slashCommandResult;\n" +
    "                }\n" +
    "            }\n" +
    "            if (!query) {\n" +
    "                const { processedQuery, error } = await handleAtCommand({\n" +
    "                    query: input,\n" +
    "                    config,\n" +
    "                    addItem: (_item, _timestamp) => 0,\n" +
    "                    onDebugMessage: () => { },\n" +
    "                    messageId: Date.now(),\n" +
    "                    signal: abortController.signal,\n" +
    "                });\n" +
    "                if (error || !processedQuery) {\n" +
    "                    // An error occurred during @include processing (e.g., file not found).\n" +
    "                    // The error message is already logged by handleAtCommand.\n" +
    "                    throw new FatalInputError(error || 'Exiting due to an error processing the @ command.');\n" +
    "                }\n" +
    "                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion\n" +
    "                query = processedQuery;\n" +
    "            }\n" +
    "            // Emit user message event for streaming JSON\n" +
    "            if (streamFormatter) {\n" +
    "                streamFormatter.emitEvent({\n" +
    "                    type: JsonStreamEventType.MESSAGE,\n" +
    "                    timestamp: new Date().toISOString(),\n" +
    "                    role: 'user',\n" +
    "                    content: input,\n" +
    "                });\n" +
    "            }\n" +
    "            let currentMessages = [{ role: 'user', parts: query }];";

  const replaceBlock =
    "// [IONOSPHERE] Native History Protocol: dual-path init\n" +
    "            let currentMessages;\n" +
    "            if (process.env.IONOSPHERE_STRUCTURED_HISTORY === 'true' && input) {\n" +
    "                const contents = JSON.parse(input);\n" +
    "                if (!Array.isArray(contents) || contents.length === 0) {\n" +
    "                    throw new FatalInputError('Structured history: stdin must be a non-empty JSON Content[] array.');\n" +
    "                }\n" +
    "                const history = contents.slice(0, -1);\n" +
    "                const current = contents[contents.length - 1];\n" +
    "                if (history.length > 0) { await geminiClient.resumeChat(history); }\n" +
    "                const textParts = (current.parts || []).filter(p => 'text' in p && typeof p.text === 'string');\n" +
    "                const textContent = textParts.map(p => p.text).join('');\n" +
    "                if (streamFormatter) {\n" +
    "                    streamFormatter.emitEvent({ type: JsonStreamEventType.INIT, timestamp: new Date().toISOString(), session_id: config.getSessionId(), model: config.getModel() });\n" +
    "                    if (textContent) { streamFormatter.emitEvent({ type: JsonStreamEventType.MESSAGE, timestamp: new Date().toISOString(), role: 'user', content: textContent }); }\n" +
    "                }\n" +
    "                currentMessages = [{ role: current.role || 'user', parts: current.parts || [] }];\n" +
    "                input = textContent || '';\n" +
    "            } else {\n" +
    "                if (streamFormatter) { streamFormatter.emitEvent({ type: JsonStreamEventType.INIT, timestamp: new Date().toISOString(), session_id: config.getSessionId(), model: config.getModel() }); }\n" +
    "                let query;\n" +
    "                if (isSlashCommand(input)) {\n" +
    "                    const slashCommandResult = await handleSlashCommand(input, abortController, config, settings);\n" +
    "                    if (slashCommandResult) { query = slashCommandResult; }\n" +
    "                }\n" +
    "                if (!query) {\n" +
    "                    const { processedQuery, error } = await handleAtCommand({ query: input, config, addItem: (_item, _timestamp) => 0, onDebugMessage: () => { }, messageId: Date.now(), signal: abortController.signal });\n" +
    "                    if (error || !processedQuery) { throw new FatalInputError(error || 'Exiting due to an error processing the @ command.'); }\n" +
    "                    query = processedQuery;\n" +
    "                }\n" +
    "                if (streamFormatter) { streamFormatter.emitEvent({ type: JsonStreamEventType.MESSAGE, timestamp: new Date().toISOString(), role: 'user', content: input }); }\n" +
    "                currentMessages = [{ role: 'user', parts: query }];\n" +
    "            }";

  if (niContent.includes(searchBlock)) {
    niContent = niContent.replace(searchBlock, replaceBlock);
    console.log("  - Applied Native History Protocol dual-path patch.");
  } else if (!niContent.includes("IONOSPHERE_STRUCTURED_HISTORY")) {
    console.warn(
      "  - WARNING: Could not find expected code block. nonInteractiveCli.js may have changed.",
    );
  } else {
    console.log("  - Native History Protocol patch already applied.");
  }

  fs.writeFileSync(nonInteractiveTarget, niContent, "utf8");
}

console.log("[Patcher] Patching complete.");
