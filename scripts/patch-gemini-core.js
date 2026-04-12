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
    configContent.includes(
      "const maybeRegister = (toolClass, registerFn) => {",
    ) &&
    !configContent.includes("internalAllowList")
  ) {
    configContent = configContent.replace(
      maybeRegisterSearch,
      maybeRegisterReplace,
    );
    console.log("  - Applied Selective Blindness to native tool registration.");
  } else if (configContent.includes("internalAllowList")) {
    console.log(
      "  - Selective Blindness patch already applied to native tool registration.",
    );
  }

  // Disable native agents (Codebase Investigator, etc.)
  const subAgentCall = /^[ \t]*this\.registerSubAgentTools\(registry\);/m;
  if (configContent.match(subAgentCall)) {
    configContent = configContent.replace(
      subAgentCall,
      "// [IONOSPHERE] Disabled native agents for security\n        // this.registerSubAgentTools(registry);",
    );
    console.log("  - Disabled native sub-agent registration.");
  } else if (configContent.includes("[IONOSPHERE] Disabled native agents")) {
    console.log("  - Native sub-agent registration already disabled.");
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
    "                    escapePastedAtSymbols: false,\n" +
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
    "// [IONOSPHERE] Native History Protocol: dual-path init (v2 — file-based ingestion)\n" +
    "            let currentMessages;\n" +
    "            if (process.env.IONOSPHERE_STRUCTURED_HISTORY === 'true') {\n" +
    "                let jsonInput;\n" +
    "                if (process.env.IONOSPHERE_HISTORY_FILE) {\n" +
    "                    const { readFileSync } = await import('node:fs');\n" +
    "                    jsonInput = readFileSync(process.env.IONOSPHERE_HISTORY_FILE, 'utf-8');\n" +
    "                } else if (input) {\n" +
    "                    jsonInput = input.trim();\n" +
    "                    const jsonStart = jsonInput.indexOf('[{\"role\":');\n" +
    "                    const jsonEnd = jsonInput.lastIndexOf(']');\n" +
    "                    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) { jsonInput = jsonInput.substring(jsonStart, jsonEnd + 1); }\n" +
    "                } else {\n" +
    "                    throw new FatalInputError('Structured history: no input provided via stdin or IONOSPHERE_HISTORY_FILE.');\n" +
    "                }\n" +
    "                const contents = JSON.parse(jsonInput).map(c => ({ ...c, content: c.content === null ? '' : c.content, parts: (c.parts || []).map(p => ('text' in p && p.text === null) ? { ...p, text: '' } : p) }));\n" +
    "                if (!Array.isArray(contents) || contents.length === 0) {\n" +
    "                    throw new FatalInputError('Structured history: parsed Content[] must be a non-empty array.');\n" +
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
    "                    const { processedQuery, error } = await handleAtCommand({ query: input, config, addItem: (_item, _timestamp) => 0, onDebugMessage: () => { }, messageId: Date.now(), signal: abortController.signal, escapePastedAtSymbols: false });\n" +
    "                    if (error || !processedQuery) { throw new FatalInputError(error || 'Exiting due to an error processing the @ command.'); }\n" +
    "                    query = processedQuery;\n" +
    "                }\n" +
    "                if (streamFormatter) { streamFormatter.emitEvent({ type: JsonStreamEventType.MESSAGE, timestamp: new Date().toISOString(), role: 'user', content: input }); }\n" +
    "                currentMessages = [{ role: 'user', parts: query }];\n" +
    "            }";

  if (niContent.includes(searchBlock)) {
    niContent = niContent.replace(searchBlock, replaceBlock);
    console.log("  - Applied Native History Protocol dual-path patch (v2 — file-based).");
  } else if (niContent.includes("IONOSPHERE_STRUCTURED_HISTORY") && !niContent.includes("IONOSPHERE_HISTORY_FILE")) {
    // Upgrade path: old v1 patch applied but missing file-based ingestion.
    // Replace the entire structured history block with the v2 version.
    console.log("  - Upgrading Native History Protocol patch to v2 (file-based ingestion)...");
    const v1Block =
      "if (process.env.IONOSPHERE_STRUCTURED_HISTORY === 'true' && input) {\n" +
      "                let jsonInput = input.trim();\n" +
      "                const jsonStart = jsonInput.indexOf('[{\"role\":');\n" +
      "                const jsonEnd = jsonInput.lastIndexOf(']');\n" +
      "                if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) { jsonInput = jsonInput.substring(jsonStart, jsonEnd + 1); }\n" +
      "                const contents = JSON.parse(jsonInput).map(c => ({ ...c, content: c.content === null ? '' : c.content, parts: (c.parts || []).map(p => ('text' in p && p.text === null) ? { ...p, text: '' } : p) }));\n" +
      "                if (!Array.isArray(contents) || contents.length === 0) {\n" +
      "                    throw new FatalInputError('Structured history: stdin must be a non-empty JSON Content[] array.');\n" +
      "                }";
    const v2Block =
      "if (process.env.IONOSPHERE_STRUCTURED_HISTORY === 'true') {\n" +
      "                let jsonInput;\n" +
      "                if (process.env.IONOSPHERE_HISTORY_FILE) {\n" +
      "                    const { readFileSync } = await import('node:fs');\n" +
      "                    jsonInput = readFileSync(process.env.IONOSPHERE_HISTORY_FILE, 'utf-8');\n" +
      "                } else if (input) {\n" +
      "                    jsonInput = input.trim();\n" +
      "                    const jsonStart = jsonInput.indexOf('[{\"role\":');\n" +
      "                    const jsonEnd = jsonInput.lastIndexOf(']');\n" +
      "                    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) { jsonInput = jsonInput.substring(jsonStart, jsonEnd + 1); }\n" +
      "                } else {\n" +
      "                    throw new FatalInputError('Structured history: no input provided via stdin or IONOSPHERE_HISTORY_FILE.');\n" +
      "                }\n" +
      "                const contents = JSON.parse(jsonInput).map(c => ({ ...c, content: c.content === null ? '' : c.content, parts: (c.parts || []).map(p => ('text' in p && p.text === null) ? { ...p, text: '' } : p) }));\n" +
      "                if (!Array.isArray(contents) || contents.length === 0) {\n" +
      "                    throw new FatalInputError('Structured history: parsed Content[] must be a non-empty array.');\n" +
      "                }";
    if (niContent.includes(v1Block)) {
      niContent = niContent.replace(v1Block, v2Block);
      console.log("  - Upgrade applied successfully.");
    } else {
      console.warn("  - WARNING: Could not find v1 upgrade anchor. Manual check required.");
    }
  } else if (niContent.includes("IONOSPHERE_HISTORY_FILE")) {
    console.log("  - Native History Protocol v2 patch (file-based) already applied.");
  } else {
    console.warn(
      "  - WARNING: Could not find expected code block. nonInteractiveCli.js may have changed.",
    );
  }

  fs.writeFileSync(nonInteractiveTarget, niContent, "utf8");
}

// 4. Patch GeminiClient.js (Lobotomy & Leak Prevention)
const clientTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "core",
  "client.js",
);
if (fs.existsSync(clientTarget)) {
  console.log(
    `[Patcher] Patching client.js (Lobotomy & Leak Prevention): ${clientTarget}`,
  );
  let clientContent = fs.readFileSync(clientTarget, "utf8");

  // 1. Lobotomize Internal Retries (Force 1 turn maximum)
  if (clientContent.includes("const MAX_TURNS = 100;")) {
    clientContent = clientContent.replace(
      "const MAX_TURNS = 100;",
      "const MAX_TURNS = 1;",
    );
    console.log("  - Lobotomized: Internal retries restricted to 1 turn.");
  }

  // 2. Leak Prevention (isToolError suppression)
  const hasPendingOriginal =
    "const hasPendingToolCall = !!lastMessage &&\n            lastMessage.role === 'model' &&\n            (lastMessage.parts?.some((p) => 'functionCall' in p) || false);";

  const leakFixReplace = `const isToolError = !!lastMessage &&
            lastMessage.role === 'user' &&
            (lastMessage.parts?.some((p) => ('functionResponse' in p &&
            !!p.functionResponse &&
            typeof p.functionResponse.response === 'object' &&
            p.functionResponse.response !== null &&
            'error' in p.functionResponse.response) ||
            ('text' in p && p.text?.startsWith('[ERROR]'))) ||
            false);`;

  if (
    clientContent.includes("const hasPendingToolCall") &&
    !clientContent.includes("isToolError")
  ) {
    clientContent = clientContent.replace(
      "const hasPendingToolCall = !!lastMessage &&\n            lastMessage.role === 'model' &&\n            (lastMessage.parts?.some((p) => 'functionCall' in p) || false);",
      (match) => `${match}\n        // [IONOSPHERE] Also avoid injecting context if the last message was a tool response
        // indicating a validation error, or a synthetic error message from the CLI.
        ${leakFixReplace}`
    );
    clientContent = clientContent.replace(
      /if \(this\.config\.getIdeMode\(\) && !hasPendingToolCall\) \{/g,
      "if ((this.config.getIdeMode ? this.config.getIdeMode() : false) && !hasPendingToolCall && !isToolError) {",
    );
    console.log("  - Applied State Leakage prevention patch.");
  } else if (clientContent.includes("isToolError")) {
    console.log("  - State Leakage prevention patch already applied.");
  }

  fs.writeFileSync(clientTarget, clientContent, "utf8");
}

// 4.1 Patch GeminiClient.js startChat (Prevent initial context leakage on stateless restart)
if (fs.existsSync(clientTarget)) {
  console.log(
    `[Patcher] Patching client.js startChat for Leak Prevention: ${clientTarget}`,
  );
  let clientContent = fs.readFileSync(clientTarget, "utf8");

  const startChatSearch =
    "const history = await getInitialChatHistory(this.config, extraHistory);";
  const startChatReplace = `const lastMessage = extraHistory && extraHistory.length > 0
            ? extraHistory[extraHistory.length - 1]
            : undefined;
        const isErrorState = !!lastMessage &&
            lastMessage.role === 'user' &&
            (lastMessage.parts?.some((p) => ('functionResponse' in p &&
            !!p.functionResponse &&
            typeof p.functionResponse.response === 'object' &&
            p.functionResponse.response !== null &&
            'error' in p.functionResponse.response) ||
            ('text' in p && p.text?.startsWith('[ERROR]'))) ||
            false);
        const history = isErrorState && extraHistory
            ? extraHistory
            : await getInitialChatHistory(this.config, extraHistory);`;

  if (clientContent.includes(startChatSearch)) {
    clientContent = clientContent.replace(startChatSearch, startChatReplace);
    console.log("  - Applied Stateless Restart Leakage prevention patch.");
  }

  fs.writeFileSync(clientTarget, clientContent, "utf8");
}

// 5. Patch scheduler.js (Model-correctable validation errors)
const schedulerTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "scheduler",
  "scheduler.js",
);
if (fs.existsSync(schedulerTarget)) {
  console.log(
    `[Patcher] Patching scheduler.js for model-correctable errors: ${schedulerTarget}`,
  );
  let schedulerContent = fs.readFileSync(schedulerTarget, "utf8");

  const validationErrorSearch =
    "response: createErrorResponse(request, e instanceof Error ? e : new Error(String(e)), ToolErrorType.INVALID_TOOL_PARAMS),";
  const validationErrorReplace = `response: createErrorResponse(request, e instanceof Error ? e : new Error(String(e)), (this.config.getDisableToolValidation ? this.config.getDisableToolValidation() : false)
                        ? ToolErrorType.EXECUTION_FAILED
                        : ToolErrorType.INVALID_TOOL_PARAMS),`;

  if (schedulerContent.includes(validationErrorSearch)) {
    schedulerContent = schedulerContent.replace(
      validationErrorSearch,
      validationErrorReplace,
    );
    console.log("  - Applied model-correctable validation error patch.");
  } else if (
    schedulerContent.includes("this.config.getDisableToolValidation()")
  ) {
    console.log(
      "  - Model-correctable validation error patch already applied.",
    );
  }

  fs.writeFileSync(schedulerTarget, schedulerContent, "utf8");
}

// 6. Patch googleQuotaErrors.js (Immediate Fallback for Capacity)
const quotaErrorsTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "utils",
  "googleQuotaErrors.js",
);
if (fs.existsSync(quotaErrorsTarget)) {
  console.log(
    `[Patcher] Patching googleQuotaErrors.js for immediate fallback: ${quotaErrorsTarget}`,
  );
  let content = fs.readFileSync(quotaErrorsTarget, "utf8");

  const capacitySearch = "if (errorInfo.reason === 'QUOTA_EXHAUSTED') {";
  const capacityReplace = `if (errorInfo.reason === 'QUOTA_EXHAUSTED' || errorInfo.reason === 'MODEL_CAPACITY_EXHAUSTED') {`;

  if (content.includes(capacitySearch) && !content.includes("MODEL_CAPACITY_EXHAUSTED")) {
    content = content.replace(capacitySearch, capacityReplace);
    console.log("  - Applied immediate fallback for MODEL_CAPACITY_EXHAUSTED.");
  }

  fs.writeFileSync(quotaErrorsTarget, content, "utf8");
}

// 7. Patch handler.js (Universal Fallback)
const handlerTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "fallback",
  "handler.js",
);
if (fs.existsSync(handlerTarget)) {
  console.log(`[Patcher] Patching handler.js for universal fallback: ${handlerTarget}`);
  let content = fs.readFileSync(handlerTarget, "utf8");

  const authCheckSearch = "if (authType !== AuthType.LOGIN_WITH_GOOGLE) {\n        return null;\n    }";
  const authCheckReplace = "// [IONOSPHERE] Universal fallback enabled\n    // if (authType !== AuthType.LOGIN_WITH_GOOGLE) {\n    //     return null;\n    // }";

  if (content.includes(authCheckSearch)) {
    content = content.replace(authCheckSearch, authCheckReplace);
    console.log("  - Enabled universal fallback for all auth types.");
  }

  fs.writeFileSync(handlerTarget, content, "utf8");
}

// 8. Patch mcp-tool.js (Raw Tool Names)
const mcpToolTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "tools",
  "mcp-tool.js",
);
if (fs.existsSync(mcpToolTarget)) {
  console.log(`[Patcher] Patching mcp-tool.js for raw tool names: ${mcpToolTarget}`);
  let content = fs.readFileSync(mcpToolTarget, "utf8");

  const generateValidNameSearch = /export function generateValidName\(name\) \{[\s\S]*?\n\}/;
  const generateValidNameReplace = `export function generateValidName(name) {
    // [IONOSPHERE] Raw Tool Names: When enabled, skip the mcp_ server prefix
    // so tools are exposed to the model by their raw names only.
    // This eliminates the dual-identity namespace collision.
    let validToolname;
    if (process.env.IONOSPHERE_RAW_TOOL_NAMES === 'true') {
        // Strip mcp_ prefix if it exists
        let rawName = name.startsWith('mcp_') ? name.slice(4) : name;
        // Input format is 'serverName_toolName' — extract just the tool part
        // by stripping everything up to and including the first underscore.
        const sepIdx = rawName.indexOf('_');
        validToolname = sepIdx !== -1 ? rawName.substring(sepIdx + 1) : rawName;
    } else {
        // Original behavior: enforce mcp_ prefix
        validToolname = name.startsWith('mcp_') ? name : \`mcp_\${name}\`;
    }
    // Replace invalid characters with underscores to conform to Gemini API:
    // ^[a-zA-Z_][a-zA-Z0-9_\\-.:]{0,63}$
    validToolname = validToolname.replace(/[^a-zA-Z0-9_\\-.:]/g, '_');
    // Ensure it starts with a letter or underscore
    if (/^[^a-zA-Z_]/.test(validToolname)) {
        validToolname = \`_\${validToolname}\`;
    }
    // If longer than the API limit, replace middle with '...'
    const safeLimit = MAX_FUNCTION_NAME_LENGTH - 1;
    if (validToolname.length > safeLimit) {
        debugLogger.warn(\`Truncating MCP tool name "\${validToolname}" to fit within the 64 character limit.\`);
        validToolname =
            validToolname.slice(0, 30) + '...' + validToolname.slice(-30);
    }
    return validToolname;
}`;

  if (content.includes("export function generateValidName(name) {")) {
    content = content.replace(generateValidNameSearch, generateValidNameReplace);
    console.log("  - Applied Raw Tool Names patch to generateValidName.");
  }

  fs.writeFileSync(mcpToolTarget, content, "utf8");
}

// 9. Patch keychainService.js (Instant FileKeychain Fallback on Linux)
// libsecret-1.so.0 is never available in the container. The native keychain
// probe (await import('keytar') + dlopen) costs 3-15s per cold spawn. Forcing
// GEMINI_FORCE_FILE_STORAGE at module-load time skips the probe entirely,
// cutting warm-up time dramatically and making the warm pool viable.
const keychainServiceTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "services",
  "keychainService.js",
);
if (fs.existsSync(keychainServiceTarget)) {
  console.log(`[Patcher] Patching keychainService.js for instant Linux fallback: ${keychainServiceTarget}`);
  let content = fs.readFileSync(keychainServiceTarget, "utf8");

  const keychainSearch = `export const FORCE_FILE_STORAGE_ENV_VAR = 'GEMINI_FORCE_FILE_STORAGE';`;
  const keychainReplace = `export const FORCE_FILE_STORAGE_ENV_VAR = 'GEMINI_FORCE_FILE_STORAGE';
// [IONOSPHERE] On Linux containers libsecret is never available — skip the
// native keytar probe entirely so each cold spawn doesn't waste 3-15 seconds.
if (process.platform === 'linux') {
    process.env[FORCE_FILE_STORAGE_ENV_VAR] = 'true';
}`;

  if (content.includes(keychainSearch) && !content.includes("[IONOSPHERE] On Linux containers")) {
    content = content.replace(keychainSearch, keychainReplace);
    console.log("  - Applied instant FileKeychain fallback for Linux.");
  } else if (content.includes("[IONOSPHERE] On Linux containers")) {
    console.log("  - Instant FileKeychain fallback patch already applied.");
  } else {
    console.warn("  - WARNING: Could not find FORCE_FILE_STORAGE_ENV_VAR in keychainService.js — skipping.");
  }

  fs.writeFileSync(keychainServiceTarget, content, "utf8");
}

// 10. Patch types.js (Enhanced JSON Protocol — THOUGHT, CITATION, SAFETY event types)
const typesTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "output",
  "types.js",
);
if (fs.existsSync(typesTarget)) {
  console.log(`[Patcher] Patching types.js for Enhanced JSON Protocol: ${typesTarget}`);
  let content = fs.readFileSync(typesTarget, "utf8");

  const typesSearch = `})(JsonStreamEventType || (JsonStreamEventType = {}));`;
  const typesReplace = `    // [IONOSPHERE] Enhanced JSON Protocol v2\n` +
    `    JsonStreamEventType["THOUGHT"] = "thought";\n` +
    `    JsonStreamEventType["CITATION"] = "citation";\n` +
    `    JsonStreamEventType["SAFETY"] = "safety";\n` +
    `    JsonStreamEventType["RETRY"] = "retry";\n` +
    `    JsonStreamEventType["MODEL_INFO"] = "model_info";\n` +
    `})(JsonStreamEventType || (JsonStreamEventType = {}));`;

  if (content.includes('JsonStreamEventType["RESULT"] = "result";') && !content.includes("RETRY")) {
    content = content.replace(typesSearch, typesReplace);
    console.log("  - Applied Enhanced JSON Protocol event types (THOUGHT, CITATION, SAFETY, RETRY, MODEL_INFO).");
  } else if (content.includes("RETRY")) {
    console.log("  - Enhanced JSON Protocol event types already applied.");
  }

  fs.writeFileSync(typesTarget, content, "utf8");
}

// 11. Patch nonInteractiveCli.js (Enhanced JSON Protocol — Thought/Citation/Finished handlers)
// This adds handlers for three event types that are currently silently dropped:
//   - GeminiEventType.Thought  -> emits JsonStreamEventType.THOUGHT (maps to reasoning_content in OpenAI)
//   - GeminiEventType.Citation -> emits JsonStreamEventType.CITATION
//   - GeminiEventType.Finished -> captures finishReason for the RESULT event
// Also adds protocol_version and capabilities to INIT events.
if (fs.existsSync(nonInteractiveTarget)) {
  console.log(`[Patcher] Patching nonInteractiveCli.js for Enhanced JSON Protocol events: ${nonInteractiveTarget}`);
  let niContent = fs.readFileSync(nonInteractiveTarget, "utf8");

  // 11a. Add Thought and Citation handlers BEFORE the Content handler.
  // Search for the Content event handler — this is the first event check in the loop.
  const contentHandlerSearch =
    "                    if (event.type === GeminiEventType.Content) {";
  const thoughtCitationHandlers =
    "                    // [IONOSPHERE] Enhanced JSON Protocol: Emit thought events for reasoning_content\n" +
    "                    if (event.type === GeminiEventType.Thought) {\n" +
    "                        if (streamFormatter) {\n" +
    "                            streamFormatter.emitEvent({\n" +
    "                                type: JsonStreamEventType.THOUGHT,\n" +
    "                                timestamp: new Date().toISOString(),\n" +
    "                                turn_id: event.traceId,\n" +
    "                                summary: event.value.subject,\n" +
    "                                content: event.value.description,\n" +
    "                            });\n" +
    "                        }\n" +
    "                    }\n" +
    "                    // [IONOSPHERE] Enhanced JSON Protocol: Emit citation events\n" +
    "                    else if (event.type === GeminiEventType.Citation) {\n" +
    "                        if (streamFormatter) {\n" +
    "                            const citationText = typeof event.value === 'string' ? event.value : '';\n" +
    "                            const citations = citationText.replace(/^Citations:\\n/, '').split('\\n').filter(Boolean);\n" +
    "                            streamFormatter.emitEvent({\n" +
    "                                type: JsonStreamEventType.CITATION,\n" +
    "                                timestamp: new Date().toISOString(),\n" +
    "                                citations: citations,\n" +
    "                            });\n" +
    "                        }\n" +
    "                    }\n" +
    "                    // [IONOSPHERE] Enhanced JSON Protocol: Capture finishReason from Finished event\n" +
    "                    else if (event.type === GeminiEventType.Finished) {\n" +
    "                        if (event.value && event.value.reason) {\n" +
    "                            lastFinishReason = event.value.reason;\n" +
    "                        }\n" +
    "                    }\n" +
    "                    // [IONOSPHERE] Enhanced JSON Protocol: Emit retry event for client-side buffer reset\n" +
    "                    else if (event.type === GeminiEventType.Retry) {\n" +
    "                        if (streamFormatter) {\n" +
    "                            streamFormatter.emitEvent({\n" +
    "                                type: JsonStreamEventType.RETRY,\n" +
    "                                timestamp: new Date().toISOString(),\n" +
    "                            });\n" +
    "                        }\n" +
    "                    }\n" +
    "                    // [IONOSPHERE] Enhanced JSON Protocol: Emit model_info when model changes (fallback)\n" +
    "                    else if (event.type === GeminiEventType.ModelInfo) {\n" +
    "                        if (streamFormatter) {\n" +
    "                            streamFormatter.emitEvent({\n" +
    "                                type: JsonStreamEventType.MODEL_INFO,\n" +
    "                                timestamp: new Date().toISOString(),\n" +
    "                                model: event.value,\n" +
    "                            });\n" +
    "                        }\n" +
    "                    }\n" +
    "                    else if (event.type === GeminiEventType.Content) {";

  if (niContent.includes(contentHandlerSearch) && !niContent.includes("GeminiEventType.Retry")) {
    niContent = niContent.replace(contentHandlerSearch, thoughtCitationHandlers);
    console.log("  - Applied Thought/Citation/Finished/Retry/ModelInfo event handlers.");
  } else if (niContent.includes("GeminiEventType.Retry")) {
    console.log("  - Thought/Citation/Finished/Retry/ModelInfo event handlers already applied.");
  } else if (niContent.includes("GeminiEventType.Thought")) {
    // Upgrade path: already has Thought but missing Retry.
    const upgradeSearch = "                    // [IONOSPHERE] Enhanced JSON Protocol: Capture finishReason from Finished event\n" +
      "                    else if (event.type === GeminiEventType.Finished) {\n" +
      "                        if (event.value && event.value.reason) {\n" +
      "                            lastFinishReason = event.value.reason;\n" +
      "                        }\n" +
      "                    }\n" +
      "                    else if (event.type === GeminiEventType.Content) {";
    
    const upgradeReplace = "                    // [IONOSPHERE] Enhanced JSON Protocol: Capture finishReason from Finished event\n" +
      "                    else if (event.type === GeminiEventType.Finished) {\n" +
      "                        if (event.value && event.value.reason) {\n" +
      "                            lastFinishReason = event.value.reason;\n" +
      "                        }\n" +
      "                    }\n" +
      "                    // [IONOSPHERE] Enhanced JSON Protocol: Emit retry event for client-side buffer reset\n" +
      "                    else if (event.type === GeminiEventType.Retry) {\n" +
      "                        if (streamFormatter) {\n" +
      "                            streamFormatter.emitEvent({\n" +
      "                                type: JsonStreamEventType.RETRY,\n" +
      "                                timestamp: new Date().toISOString(),\n" +
      "                            });\n" +
      "                        }\n" +
      "                    }\n" +
      "                    // [IONOSPHERE] Enhanced JSON Protocol: Emit model_info when model changes (fallback)\n" +
      "                    else if (event.type === GeminiEventType.ModelInfo) {\n" +
      "                        if (streamFormatter) {\n" +
      "                            streamFormatter.emitEvent({\n" +
      "                                type: JsonStreamEventType.MODEL_INFO,\n" +
      "                                timestamp: new Date().toISOString(),\n" +
      "                                model: event.value,\n" +
      "                            });\n" +
      "                        }\n" +
      "                    }\n" +
      "                    else if (event.type === GeminiEventType.Content) {";
    
    if (niContent.includes(upgradeSearch)) {
      niContent = niContent.replace(upgradeSearch, upgradeReplace);
      console.log("  - Upgraded Enhanced JSON Protocol event handlers to include Retry/ModelInfo.");
    }
  }

  // 11b. Add lastFinishReason variable declaration after 'let responseText'.
  const responseTextSearch = "                let responseText = '';";
  const responseTextReplace = "                let responseText = '';\n" +
    "                let lastFinishReason = 'stop'; // [IONOSPHERE] Track finish reason from Finished events";

  if (niContent.includes(responseTextSearch) && !niContent.includes("let lastFinishReason")) {
    niContent = niContent.replace(responseTextSearch, responseTextReplace);
    console.log("  - Applied lastFinishReason variable declaration.");
  }

  // 11c. Add finish_reason to all RESULT events.
  // The RESULT event is emitted in 3 places with 2 indentation levels.
  // 28-space indent (1 occurrence: final else path)
  const resultSearch28 = "                            status: 'success',\n" +
    "                            stats: streamFormatter.convertToStreamStats(metrics, durationMs),";
  const resultReplace28 = "                            status: 'success',\n" +
    "                            finish_reason: lastFinishReason || 'stop',\n" +
    "                            stats: streamFormatter.convertToStreamStats(metrics, durationMs),";

  // 32-space indent (2 occurrences: AgentExecutionStopped and StopExecution paths)
  const resultSearch32 = "                                status: 'success',\n" +
    "                                stats: streamFormatter.convertToStreamStats(metrics, durationMs),";
  const resultReplace32 = "                                status: 'success',\n" +
    "                                finish_reason: lastFinishReason || 'stop',\n" +
    "                                stats: streamFormatter.convertToStreamStats(metrics, durationMs),";

  if (!niContent.includes("finish_reason")) {
    if (niContent.includes(resultSearch28)) {
      niContent = niContent.replaceAll(resultSearch28, resultReplace28);
    }
    if (niContent.includes(resultSearch32)) {
      niContent = niContent.replaceAll(resultSearch32, resultReplace32);
    }
    console.log("  - Applied finish_reason to RESULT events.");
  }

  // 11d. Add protocol_version and capabilities to INIT events.
  // There are 2 INIT events (structured history path and normal path).
  const initSearch = "session_id: config.getSessionId(), model: config.getModel() });";
  const initReplace = "session_id: config.getSessionId(), model: config.getModel(), protocol_version: 2, capabilities: ['thought', 'citation', 'safety'] });";

  if (niContent.includes(initSearch) && !niContent.includes("protocol_version")) {
    niContent = niContent.replaceAll(initSearch, initReplace);
    console.log("  - Applied protocol_version and capabilities to INIT events.");
  }

  // 11e. Add SAFETY event to AgentExecutionBlocked handler.
  const blockedSearch =
    "                    else if (event.type === GeminiEventType.AgentExecutionBlocked) {\n" +
    "                        const blockMessage = `Agent execution blocked: ${event.value.systemMessage?.trim() || event.value.reason}`;\n" +
    "                        if (config.getOutputFormat() === OutputFormat.TEXT) {\n" +
    "                            process.stderr.write(`[WARNING] ${blockMessage}\\n`);\n" +
    "                        }\n" +
    "                    }";
  const blockedReplace =
    "                    else if (event.type === GeminiEventType.AgentExecutionBlocked) {\n" +
    "                        const blockMessage = `Agent execution blocked: ${event.value.systemMessage?.trim() || event.value.reason}`;\n" +
    "                        if (config.getOutputFormat() === OutputFormat.TEXT) {\n" +
    "                            process.stderr.write(`[WARNING] ${blockMessage}\\n`);\n" +
    "                        }\n" +
    "                        // [IONOSPHERE] Enhanced JSON Protocol: Emit safety event\n" +
    "                        if (streamFormatter) {\n" +
    "                            streamFormatter.emitEvent({\n" +
    "                                type: JsonStreamEventType.SAFETY,\n" +
    "                                timestamp: new Date().toISOString(),\n" +
    "                                blocked: true,\n" +
    "                                reason: event.value.reason,\n" +
    "                            });\n" +
    "                        }\n" +
    "                    }";

  if (niContent.includes(blockedSearch) && !niContent.includes("JsonStreamEventType.SAFETY")) {
    niContent = niContent.replace(blockedSearch, blockedReplace);
    console.log("  - Applied SAFETY event emission to AgentExecutionBlocked handler.");
  }

  fs.writeFileSync(nonInteractiveTarget, niContent, "utf8");
}

// 12. Patch GeminiChat.js (Mid-Stream Fallback)
const chatTarget = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "core",
  "geminiChat.js",
);
if (fs.existsSync(chatTarget)) {
  console.log(`[Patcher] Patching GeminiChat.js for mid-stream fallback: ${chatTarget}`);
  let content = fs.readFileSync(chatTarget, "utf8");

  // We want to inject fallback logic into the streamWithRetries catch block.
  // This allows the model to switch even if the error happens after the stream starts.
  const streamRetrySearch = `                        // If we've aborted, we throw without logging a failure.
                        if (signal.aborted) {
                            throw error;
                        }
                        logContentRetryFailure(this.context.config, new ContentRetryFailureEvent(attempt + 1, errorType, model));
                        throw error;`;

  const streamRetryReplace = `                        // If we've aborted, we throw without logging a failure.
                        if (signal.aborted) {
                            throw error;
                        }
                        
                        // [IONOSPHERE] Mid-Stream Fallback: Try to switch models only for auto-* selections
                        try {
                            const modelName = model || "";
                            if (typeof modelName === 'string' && modelName.startsWith('auto-')) {
                                const { handleFallback } = await import('../fallback/handler.js');
                                const fallbackModel = await handleFallback(this.context.config, model, this.context.config.getContentGeneratorConfig()?.authType, error);
                                if (fallbackModel) {
                                    attempt = 0; // Reset attempts to try again with the new model
                                    continue;
                                }
                            }
                        } catch (fErr) {
                            // If fallback fails, just log and throw original error
                        }

                        logContentRetryFailure(this.context.config, new ContentRetryFailureEvent(attempt + 1, errorType, model));
                        throw error;`;

  if (content.includes(streamRetrySearch)) {
    content = content.replace(streamRetrySearch, streamRetryReplace);
    console.log("  - Applied Mid-Stream Fallback logic to streamWithRetries.");
  } else if (content.includes("// [IONOSPHERE] Mid-Stream Fallback") && !content.includes("modelName.startsWith('auto-')")) {
    console.log("  - Upgrading existing Mid-Stream Fallback logic...");
    // Very coarse upgrade: find the old comment and replace the whole block until the next known line
    const oldBlockSearch = /\/\/ \[IONOSPHERE\] Mid-Stream Fallback: Try to switch models if retries exhausted or terminal error[\s\S]*?logContentRetryFailure/g;
    const upgradeReplace = `// [IONOSPHERE] Mid-Stream Fallback: Try to switch models only for auto-* selections
                        try {
                            const modelName = model || "";
                            if (typeof modelName === 'string' && modelName.startsWith('auto-')) {
                                const { handleFallback } = await import('../fallback/handler.js');
                                const fallbackModel = await handleFallback(this.context.config, model, this.context.config.getContentGeneratorConfig()?.authType, error);
                                if (fallbackModel) {
                                    attempt = 0; // Reset attempts to try again with the new model
                                    continue;
                                }
                            }
                        } catch (fErr) {
                            // If fallback fails, just log and throw original error
                        }

                        logContentRetryFailure`;
    content = content.replace(oldBlockSearch, upgradeReplace);
    console.log("  - Upgraded Mid-Stream Fallback logic.");
  } else if (content.includes("modelName.startsWith('auto-')")) {
    console.log("  - Mid-Stream Fallback (Auto-restricted) already applied.");
  }

  fs.writeFileSync(chatTarget, content, "utf8");
}

console.log("[Patcher] Patching complete.");
