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
    "// [IONOSPHERE] Native History Protocol: dual-path init\n" +
    "            let currentMessages;\n" +
    "            if (process.env.IONOSPHERE_STRUCTURED_HISTORY === 'true' && input) {\n" +
    "                let jsonInput = input.trim();\n" +
    "                const jsonStart = jsonInput.indexOf('[{\"role\":');\n" +
    "                const jsonEnd = jsonInput.lastIndexOf(']');\n" +
    "                if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) { jsonInput = jsonInput.substring(jsonStart, jsonEnd + 1); }\n" +
    "                const contents = JSON.parse(jsonInput).map(c => ({ ...c, content: c.content === null ? '' : c.content, parts: (c.parts || []).map(p => ('text' in p && p.text === null) ? { ...p, text: '' } : p) }));\n" +
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
    "                    const { processedQuery, error } = await handleAtCommand({ query: input, config, addItem: (_item, _timestamp) => 0, onDebugMessage: () => { }, messageId: Date.now(), signal: abortController.signal, escapePastedAtSymbols: false });\n" +
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

console.log("[Patcher] Patching complete.");
