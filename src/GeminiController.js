import { spawn } from "child_process";
import EventEmitter from "events";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { performance } from "perf_hooks";

import { createError, ErrorType, ErrorCode } from "./errorHandler.js";
import { RepetitionBreaker } from "./RepetitionBreaker.js";
import { CliRunner } from "./CliRunner.js";
import { CliErrorParser } from "./CliErrorParser.js";

const PERF_ENABLED = process.env.GEMINI_PERF_TIMING === "true";

/**
 * Accumulates chunked stdout into distinct JSON lines.
 */
export class JsonlAccumulator extends EventEmitter {
  constructor() {
    super();
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.toString();

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const parsed = JSON.parse(line);
          this.emit("line", parsed);
        } catch (e) {
          console.error(`[JsonlAccumulator] Failed to parse line: ${line}`, e);
          this.emit("parse_error", { raw: line, error: e.message });
        }
      }
    }
  }
}

/**
 * Buffers text chunks to ensure that tags (like [Action...]) and newlines
 * are not incorrectly stripped or leaked when split across chunks.
 */
export class StreamingCleaner {
  constructor(on_text, turnId, processes) {
    this.on_text = on_text;
    this.turnId = turnId;
    this.processes = processes;
    this.buffer = "";
    this.flushed = false; // Guard against double-flush
  }

  push(chunk) {
    this.buffer += chunk;
    this.process(false);
  }

  process(isFinal = false) {
    try {
      // Regexes used for cleaning.
      // IMPORTANT: 'resultRegex' lookahead must NOT include '$' unless it's the final flush,
      // otherwise it will consume trailing text as if it were part of a result tag.
      // Anchored to require newline or start-of-string before '[Action' to prevent false matches on JSON content.
      const actionRegex =
        /(?:^|\n)\[Action \(id: ([^)]*)\): Called tool '([^']+)' with args: (.*?)\]/gs;
      const lookahead = isFinal
        ? "(?=\\n\\n|\\[Action|\\[Tool Result|USER:|$)"
        : "(?=\\n\\n|\\[Action|\\[Tool Result|USER:)";
      const resultRegex = new RegExp(
        `(?:^|\\n)\\[Tool Result \\(id: ([^)]*)\\)\\]:[^]*?${lookahead}`,
        "gs",
      );

      // Before stripping, intercept "leaked" tool calls for Turn forensics/hijacking.
      // We only do this if we find a complete tag.
      let match;
      const proc = this.processes.get(this.turnId);
      if (proc && proc.activeCallbacks) {
        const tempActionRegex = new RegExp(actionRegex);
        while ((match = tempActionRegex.exec(this.buffer)) !== null) {
          const [fullMatch, callId, toolName, argsStr] = match;
          const alreadySeen = Array.from(proc.toolUsage || []).includes(toolName);
          const isLikelyHallucination =
            !argsStr || argsStr.trim() === "{}" || argsStr.trim().length < 2;

          if (!alreadySeen && !isLikelyHallucination) {
            if (process.env.GEMINI_DEBUG_RESPONSES === "true") {
              console.log(
                `[GeminiController] Intercepted leaked tool call in streaming buffer for Turn ${this.turnId}: ${toolName} (${callId})`,
              );
            }
            if (proc.activeCallbacks.onToolCall) {
              proc.activeCallbacks.onToolCall({
                id: callId.startsWith("leak_") ? callId : `leak_${callId}`,
                name: toolName,
                arguments: argsStr.trim(),
              });
            }
            proc.toolUsage.add(toolName);
          }
        }
      }

      // Perform cleaning on the buffer
      let cleaned = this.buffer.replace(actionRegex, "").replace(resultRegex, "");

      // Safely emit text that is NOT likely part of a pending tag or lookahead.
      // We buffer aggressively if not final.
      if (isFinal) {
        if (cleaned && !this.flushed) {
          this.on_text(cleaned);
        }
        this.buffer = "";
        this.flushed = true;
      } else {
        const bufferMargin = 200; // Increased to handle long tool arguments
        const safeLength = cleaned.length - bufferMargin;
        if (safeLength > 0) {
          // Find the latest point that is definitely NOT part of a tag prefix.
          // We look for the LAST occurrence of '[', '<', or even '\n' (as it might be part of \n\n)
          const lastTagStart = Math.max(
            cleaned.lastIndexOf("["),
            cleaned.lastIndexOf("<"),
          );
          const lastBoundary = Math.max(lastTagStart, cleaned.lastIndexOf("\n"));

          let emitEnd = cleaned.length;
          if (lastBoundary !== -1 && lastBoundary > safeLength) {
            emitEnd = lastBoundary;
          } else if (lastBoundary === -1) {
            // No potential tags in the last 200 chars, safe to emit
            emitEnd = cleaned.length;
          }

          const toEmit = cleaned.slice(0, emitEnd);
          if (toEmit) {
            this.on_text(toEmit);
            this.buffer = cleaned.slice(emitEnd);
          }
        }
      }
    } catch (e) {
      console.error(`[StreamingCleaner] Regex processing error: ${e.message}. Flushing buffer as-is.`);
      if (this.buffer && this.on_text) {
        this.on_text(this.buffer);
      }
      this.buffer = "";
    }
  }

  flush() {
    if (this.flushed) return; // Idempotent
    this.process(true);
  }
}

/**
 * GeminiController — Stateless CLI Spawner
 */
export class GeminiController extends EventEmitter {
  constructor(cwd = process.cwd()) {
    super();
    this.cwd = cwd;
    this.tempDir = path.join(this.cwd, "temp");
    this.processes = new Map();

    // Active callbacks for each turnId
    this.callbacksByTurn = new Map();

    // Component instances
    this.repetitionBreaker = new RepetitionBreaker();
    this.cliRunner = new CliRunner(this.cwd);
    this.errorParser = new CliErrorParser();

    this.warmPool = new Map(); // hash -> Array of warm processes
    this.warmPoolSize = parseInt(process.env.GEMINI_WARM_POOL_SIZE) || 1;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Generates a stable hash string for a given CLI configuration.
   */
  hashConfig(workspacePath, settingsPath, systemPrompt, attachments = []) {
    // Normalization: Ensure relative paths or stable basenames for hash consistency 
    // when running in different environments (dev vs prod vs container).
    const stableWorkspace = path.basename(workspacePath);
    const stableSettings = path.basename(settingsPath);
    
    return JSON.stringify({ 
      workspace: stableWorkspace, 
      settings: stableSettings, 
      systemPrompt: null, // Always null in hash for pooling (Lazy-read from system.md)
      attachments: attachments.map(a => path.basename(a.path || a)) 
    });
  }

  /**
   * Spawns a background process and waits for it to become warm.
   */
  replenishPool(hashKey, workspacePath, spawnEnv, executable, finalArgs) {
    const currentPool = this.warmPool.get(hashKey) || [];
    if (currentPool.length >= this.warmPoolSize) return;

    if (process.env.GEMINI_DEBUG_PROMPTS === "true") {
      console.log(`[GeminiController] Background spawning WARM process for pool. Size: ${currentPool.length}`);
    }
    
    const proc = spawn(executable, finalArgs, {
      cwd: workspacePath,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    proc.isWarm = false;
    proc.rawOutputBuffer = []; // Reactive Debugging
    
    // Attach a temporary accumulator to listen for the INIT event
    const accumulator = new JsonlAccumulator();
    proc.warmAccumulator = accumulator;
    
    proc.stdout.on("data", (chunk) => {
       const lines = chunk.toString().split("\n");
       for (const line of lines) {
         if (line.trim()) {
           proc.rawOutputBuffer.push(line.trim());
           if (proc.rawOutputBuffer.length > 60) proc.rawOutputBuffer.shift();
         }
       }
       if (proc.isWarmLogStream) proc.isWarmLogStream.write(chunk);
       accumulator.push(chunk);
    });

    const initListener = (json) => {
      if (json.type === "init") {
        proc.isWarm = true;
        if (process.env.GEMINI_DEBUG_PROMPTS === "true") {
           console.log(`[GeminiController] WARM process ready (INIT received)`);
        }
        accumulator.removeListener("line", initListener);
      }
    };
    accumulator.on("line", initListener);

    proc.on("error", (err) => {
      console.error(`[GeminiController] Warm process error: ${err.message}`);
      const pool = this.warmPool.get(hashKey) || [];
      this.warmPool.set(hashKey, pool.filter(p => p !== proc));
    });
    
    proc.on("close", () => {
      const pool = this.warmPool.get(hashKey) || [];
      this.warmPool.set(hashKey, pool.filter(p => p !== proc));
    });

    currentPool.push(proc);
    this.warmPool.set(hashKey, currentPool);
  }

  /**
   * Seeds the warm pool at server startup so the first request gets a warm process.
   * Spawns a plain stateless CLI with no prompt — the process blocks at stdin-read
   * after emitting 'init', consuming ~0 CPU until a turn arrives.
   * Call once after the HTTP server starts listening.
   */
  prewarmDefault() {
    const settingsPath =
      process.env.GEMINI_SETTINGS_JSON ||
      path.join(this.cwd, ".gemini", "settings.json");
    const { executable, initialArgs } = this.cliRunner.getExecutableAndArgs();
    const finalArgs = this.cliRunner.buildFinalArgs(initialArgs, { attachments: [] });
    const spawnEnv = this.cliRunner.prepareEnv(settingsPath, {}, null);
    // systemPrompt=null so the pool key matches turns regardless of system prompt content
    const hashKey = this.hashConfig(this.cwd, settingsPath, null, []);
    const count = parseInt(process.env.GEMINI_WARM_POOL_SIZE) || 1;
    console.log(`[GeminiController] Server startup: seeding ${count} warm process(es) into pool...`);
    for (let i = 0; i < count; i++) {
      this.replenishPool(hashKey, this.cwd, spawnEnv, executable, finalArgs);
    }
  }

  /**
   * Updates the callbacks for a running turn.
   * Essential for "Warm Stateless Handoff" where a second HTTP request
   * takes over the output of a process parked from a first request.
   */
  updateCallbacks(turnId, callbacks, extraEnv = null) {
    const previous = this.callbacksByTurn.has(turnId);
    this.callbacksByTurn.set(turnId, callbacks);

    if (extraEnv) {
      const proc = this.processes.get(turnId);
      if (proc) {
        // Sync historical context into the running process tracker
        proc.extraEnv = { ...(proc.extraEnv || {}), ...extraEnv };
      }
    }

    if (previous) {
      console.log(
        `[GeminiController] Callbacks ${extraEnv ? "AND extraEnv " : ""}HIJACKED for turn ${turnId}`,
      );
    } else {
      console.warn(
        `[GeminiController] Callbacks registered for INACTIVE turn ${turnId}`,
      );
    }
  }

  /**
   * Executes a strictly stateless CLI turn.
   * 1. Spawn `gemini -y -o stream-json -p <text> --settings <settingsPath>`
   * 2. Stream output events back via callbacks.
   */
  async sendPrompt(
    turnId,
    text,
    workspacePath = this.cwd,
    settingsPath = process.env.GEMINI_SETTINGS_JSON ||
      path.join(this.cwd, ".gemini", "settings.json"),
    systemPrompt = null,
    callbacks = {},
    extraEnv = {},
    attachments = [],
    structuredContents = null,
  ) {
    try {
      this.callbacksByTurn.set(turnId, callbacks);

      // Structured History Mode: write Content[] JSON to temp file
      // to bypass stdin pipe backpressure (eliminates ~12s delay for large prompts).
      let historyFilePath = null;
      let actualPayloadBytes = 0;
      if (structuredContents) {
        extraEnv.IONOSPHERE_STRUCTURED_HISTORY = "true";
        historyFilePath = path.join(this.tempDir, `turn-${turnId}-history.json`);
        const jsonPayload = JSON.stringify(structuredContents);
        actualPayloadBytes = jsonPayload.length;
        fs.writeFileSync(historyFilePath, jsonPayload, "utf-8");
        extraEnv.IONOSPHERE_HISTORY_FILE = historyFilePath;
        console.log(`[GeminiController] [Turn ${turnId}] Wrote structured history to file (${Math.round(actualPayloadBytes / 1024)} KB): ${historyFilePath}`);
      }

      let systemPromptPath = null;
      if (systemPrompt !== null) {
        systemPromptPath = path.join(workspacePath, "system.md");
        await fsp.writeFile(systemPromptPath, systemPrompt, "utf-8");
      }

      const { executable, initialArgs } = this.cliRunner.getExecutableAndArgs();
      const finalArgs = this.cliRunner.buildFinalArgs(initialArgs, {
        attachments,
      });

      // Persistence for debugging
      if (process.env.GEMINI_DEBUG_PROMPTS === "true") {
        const debugDir = path.join(this.cwd, "debug_prompts");
        if (!fs.existsSync(debugDir))
          await fsp.mkdir(debugDir, { recursive: true });
        
        // Save the raw text prompt (as it would be if not using structured history)
        await fsp.writeFile(
          path.join(debugDir, `turn-${turnId}-prompt.txt`),
          text,
          "utf-8",
        );

        // Save the structured Content[] if it exists
        if (structuredContents) {
          await fsp.writeFile(
            path.join(debugDir, `turn-${turnId}-content.json`),
            JSON.stringify(structuredContents, null, 2),
            "utf-8",
          );
        }

        if (systemPromptPath) {
          await fsp.copyFile(
            systemPromptPath,
            path.join(debugDir, `turn-${turnId}-system.md`),
          );
        }
      }

      const spawnEnv = this.cliRunner.prepareEnv(
        settingsPath,
        extraEnv,
        systemPromptPath,
      );

      // Exclude systemPrompt from the pool key — it is written to system.md
      // before stdin is sent, and the CLI reads it lazily at request time.
      // This ensures warm processes seeded at startup (with no system prompt)
      // match every incoming turn regardless of repetition-breaker drift.
      const hashKey = this.hashConfig(workspacePath, settingsPath, null, attachments);

      const result = await new Promise((resolve, reject) => {
        const promiseStartTime = PERF_ENABLED ? performance.now() : 0;
        let lastResultJson = null;
        let proc = null;
        let accumulator = null;

        const currentPool = this.warmPool.get(hashKey) || [];
        if (currentPool.length > 0) {
          const readyIdx = currentPool.findIndex(p => p.isWarm);
          if (readyIdx !== -1) {
            proc = currentPool.splice(readyIdx, 1)[0];
            accumulator = proc.warmAccumulator;
            proc._perfSpawnMethod = "warm";
            console.log(`[GeminiController] Acquired WARM process from pool!`);
          } else {
            // Case: Process is still 'warming' (waiting for INIT).
            // Instead of cold-spawning, we wait briefly for it to become warm.
            proc = currentPool.shift();
            accumulator = proc.warmAccumulator;
            proc._perfSpawnMethod = "warming";
            console.log(`[GeminiController] Acquired WARMING process from pool. Waiting for INIT...`);
          }
        }

        if (!proc) {
          if (process.env.GEMINI_DEBUG_PROMPTS === "true") {
            const poolKeys = Array.from(this.warmPool.keys());
            console.warn(`[GeminiController] [Turn ${turnId}] Pool miss. Requested Hash Key: ${hashKey}`);
            console.warn(`[GeminiController] Existing Pool Keys (${poolKeys.length}): ${JSON.stringify(poolKeys)}`);
          }
          console.log(`[GeminiController] [Turn ${turnId}] Pool miss. Spawning cold stateless CLI: ${executable} ${finalArgs.join(" ")}`);
          const spawnT0 = PERF_ENABLED ? performance.now() : 0;
          proc = spawn(executable, finalArgs, {
            cwd: workspacePath,
            env: spawnEnv,
            stdio: ["pipe", "pipe", "pipe"],
            shell: process.platform === "win32",
          });
          
          proc._perfSpawnMethod = "cold";
          if (PERF_ENABLED) {
            proc._perfSpawnMs = performance.now() - spawnT0;
          }
          proc.currentPhase = "spawning";
          proc.spawnStartTime = Date.now();
          if (process.env.GEMINI_DEBUG_PROMPTS === "true") {
            console.log(`[GeminiController] [Turn ${turnId}] Spawned CLI process ${proc.pid}`);
          }
          
          accumulator = new JsonlAccumulator();
          proc.rawOutputBuffer = []; // Reactive Debugging
          proc.stdout.on("data", (chunk) => {
            if (!proc.firstByteTime) {
              proc.firstByteTime = Date.now();
              proc.currentPhase = "responding";
              const startupDuration = proc.firstByteTime - (proc.spawnStartTime || Date.now());
              console.log(`[GeminiController] [Turn ${turnId}] First byte received (TTFB) after ${startupDuration}ms`);
            }
            const lines = chunk.toString().split("\n");
            for (const line of lines) {
              if (line.trim()) {
                proc.rawOutputBuffer.push(line.trim());
                if (proc.rawOutputBuffer.length > 60) proc.rawOutputBuffer.shift();
              }
            }
            if (proc.isWarmLogStream) proc.isWarmLogStream.write(chunk);
            accumulator.push(chunk);
          });
        }

        // Background replenish
        setTimeout(() => {
          this.replenishPool(hashKey, workspacePath, spawnEnv, executable, finalArgs);
        }, 0);

        if (process.env.GEMINI_DEBUG_PROMPTS === "true") {
          const hijackedFrom = this.callbacksByTurn.get(turnId)?.hijackedFrom;
          const context = hijackedFrom
            ? ` (Hijacked from ${hijackedFrom})`
            : "";
          console.log(
            `[GeminiController] TURN=${turnId}${context} STDIN_PROMPT=true HASH=${extraEnv.IONOSPHERE_HISTORY_HASH || "none"}`,
          );
          console.log(
            `[GeminiController] RAW PROMPT (First 500 chars):\n${text.substring(0, 500)}...`,
          );
        }

        // Diagnostic: log env size to help diagnose E2BIG
        const envEntries = Object.entries(spawnEnv);

        // Write prompt content to stdin and signal EOF
        // When historyFilePath is set, the structured history is read from file
        // by the CLI — we only send a minimal stub through stdin to pass the
        // CLI's non-empty input check.
        const stdinContent = historyFilePath
          ? "__ionosphere_file_mode__"
          : text;
        
        proc.stdinStartTime = Date.now();
        proc.currentPhase = historyFilePath ? "file_mode" : "uploading_prompt";
        if (!historyFilePath && stdinContent.length > 200000) {
           console.log(`[GeminiController] [Turn ${turnId}] Starting large prompt upload to stdin (${Math.round(stdinContent.length / 1024)} KB)...`);
        }

        proc.stdin.on("error", (err) => {
          if (err.code === "EPIPE" && proc.isCancelled) {
             console.warn(`[GeminiController] [Turn ${turnId}] Stdin Pipe closed during cancellation (expected EPIPE).`);
             return;
          }
          console.error(`[GeminiController] [Turn ${turnId}] Stdin Error:`, err.message);
        });

        try {
          proc.stdin.end(stdinContent, "utf-8", () => {
             proc.stdinEndTime = Date.now();
             proc.currentPhase = "model_thinking";
             const uploadDuration = proc.stdinEndTime - proc.stdinStartTime;
             if (historyFilePath) {
                console.log(`[GeminiController] [Turn ${turnId}] Stdin stub sent in ${uploadDuration}ms (payload via file: ${Math.round(actualPayloadBytes / 1024)} KB)`);
             } else if (stdinContent.length > 200000 || process.env.GEMINI_DEBUG_PROMPTS === "true") {
                console.log(`[GeminiController] [Turn ${turnId}] Stdin finalized (payload: ${Math.round(stdinContent.length / 1024)} KB) in ${uploadDuration}ms`);
             }
          });
        } catch (err) {
          console.error(`[GeminiController] [Turn ${turnId}] Failed to end stdin:`, err.message);
        }

        proc.extraEnv = extraEnv; // Initialize with spawn env
        proc.toolUsage = new Set(); // Track real tool calls in this turn
        proc.accumulatedText = ""; // Track full text for repeat detection
        proc._historyFilePath = historyFilePath; // For cleanup on close
        proc._perfStdinPayloadBytes = actualPayloadBytes || stdinContent.length;
        if (PERF_ENABLED) {
          proc._perfPromiseStart = promiseStartTime;
        }
        this.processes.set(turnId, proc);

        // 2-hour timeout for ReAct loops (human-in-the-loop scale)
        const TURN_TIMEOUT_MS =
          parseInt(process.env.TURN_TIMEOUT_MS) || 120 * 60 * 1000;
        const timeout = setTimeout(() => {
          console.error(
            `[GeminiController] FATAL: Turn ${turnId} timed out after ${TURN_TIMEOUT_MS / 60000}m. Active tools: ${Array.from(proc.toolUsage).join(", ")}. Killing process.`,
          );
          proc.kill("SIGKILL");
          reject(new Error(`Turn timed out after ${TURN_TIMEOUT_MS / 60000}m`));
        }, TURN_TIMEOUT_MS);

        accumulator.on("parse_error", ({ raw, error }) => {
          console.error(`[GeminiController] [Turn ${turnId}] JSONL Parse Error: ${error}. Raw: ${raw.substring(0, 200)}`);
          const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
          if (activeCallbacks.onEvent) {
            activeCallbacks.onEvent({ type: "parse_error", message: error, raw: raw.substring(0, 500) });
          }
        });

        accumulator.on("line", (json) => {
          const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
          proc.activeCallbacks = activeCallbacks; // Shared reference for StreamingCleaner

          if (process.env.GEMINI_DEBUG_RAW === "true") {
            console.log(
              `[Turn ${turnId}] CLI Raw Line: ${JSON.stringify(json)}`,
            );
          } else if (json.type !== "message" || process.env.GEMINI_DEBUG_RAW === "true") {
            console.log(
              `[Turn ${turnId}] CLI Raw Line: ${json.type}${json.role ? " [" + json.role + "]" : ""}`,
            );
          }
          
          if (json.type === "message") {
             const keys = Object.keys(json.content || {});
             if (json.content?.thought || json.content?.thinking || json.thinking) {
                console.log(`[GeminiController] [Turn ${turnId}] 🧠 DETECTED REASONING/THOUGHT tokens in message (Keys: ${keys.join(", ")}).`);
             }
          }

          // [IONOSPHERE] Handle explicit retry signal from mid-stream fallback
          if (json.type === "retry") {
            const reason = json.reason || "unknown";
            const attempt = json.attempt || 1;
            console.log(`[GeminiController] [Turn ${turnId}] 🔄 RETRY SIGNAL RECEIVED (Attempt ${attempt}, Reason: ${reason}). Clearing buffers.`);
            
            // 1. Clear text buffers to prevent "Hello Hello world" doubling
            proc.accumulatedText = ""; 
            if (proc.cleaner) {
              proc.cleaner.buffer = "";
            }
            
            // 2. Clear tool usage for this specific attempt (allow re-calling)
            proc.toolUsage = new Set();
            
            // 3. Reset TTFB tracking for the new attempt
            proc.firstByteTime = null; 
            
            // 4. Signal to bridge (index.js) so it can send SSE comments
            if (activeCallbacks.onEvent) {
              activeCallbacks.onEvent({ 
                type: "retry", 
                attempt: attempt, 
                reason: reason,
                prev_model: json.prev_model 
              });
            }
            return; // Don't process further for this line
          }

          // [IONOSPHERE] Handle model update signal
          if (json.type === "model_info") {
            const model = json.model || json.value;
            const attempt = json.attempt || 1;
            console.log(`[GeminiController] [Turn ${turnId}] 🤖 Model switched to: ${model} (Attempt ${attempt})`);
            
            if (activeCallbacks.onEvent) {
              activeCallbacks.onEvent({ 
                type: "model_info", 
                model: model,
                attempt: attempt,
                fallback: !!json.fallback
              });
            }
            return;
          }

          // NO-OP: Stall detector is now reset on raw stdout data below
          // to ensure we catch partial lines or slow token streams.
          
          if (json.type === "message" && json.role === "assistant") {
            // Track first model text for perf timing
            if (PERF_ENABLED && !proc._perfFirstTextTime) {
              proc._perfFirstTextTime = performance.now();
            }
            const content =
              typeof json.content === "object"
                ? json.content.text
                : json.content;
            if (content) {
              // Use StreamingCleaner logic to handle chunk-boundary state
              if (!proc.cleaner) {
                proc.cleaner = new StreamingCleaner(
                  (text) => {
                    const shouldKill =
                      this.repetitionBreaker.checkTextRepetition(
                        proc,
                        text,
                        turnId,
                        this.callbacksByTurn.get(turnId) || {},
                      );

                    if (shouldKill) {
                      proc.kill("SIGKILL");
                      return;
                    }

                    // Re-read active callbacks to ensure we use the latest reference
                    const currentCallbacks =
                      this.callbacksByTurn.get(turnId) || {};
                    if (currentCallbacks.onText) {
                      currentCallbacks.onText(text);
                    }
                  },
                  turnId,
                  this.processes,
                );
              }
              proc.cleaner.push(content);
            }
          } else if (json.type === "tool_use" || json.type === "toolCall") {
            const toolName = json.tool_name || json.name;
            if (process.env.GEMINI_DEBUG_PARALLEL === "true") {
              console.log(
                `[Turn ${turnId}] GeminiController: Received tool_use for ${toolName}`,
              );
            }
            // Flush any pending text before a tool use event
            if (proc.cleaner) proc.cleaner.flush();
            const argsObj = json.arguments || {};

            // Track real usage to suppress "echo leaks"
            this.processes.get(turnId)?.toolUsage.add(toolName);

            // Repeat Breaker Logic (Global per historyHash)
            const repeatStatus = this.repetitionBreaker.checkToolRepeatLimit(
              proc,
              toolName,
              argsObj,
              extraEnv.IONOSPHERE_HISTORY_HASH,
              extraEnv.IONOSPHERE_HISTORY_TOOLS,
              activeCallbacks,
            );

            if (repeatStatus === "KILL") {
              proc.kill();
              return;
            }
            if (repeatStatus === "IGNORE") return;

            const transparentTools = ["google_web_search"];
            if (transparentTools.includes(toolName)) {
              console.log(
                `[GeminiController] Transparently executing native tool: ${toolName}`,
              );
              if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
            } else {
              // Non-transparent tools (MCP tools) are handled via the ionosphere-tool-bridge and IPC.
              // We do NOT dispatch onToolCall here to avoid double-dispatching to the client.
              // The IPC server in index.js will handle the actual dispatch and hijacking.
              if (process.env.GEMINI_DEBUG_RESPONSES === "true") {
                console.log(
                  `[GeminiController] Suppressing redundant JSON-stream dispatch for tool: ${toolName} (Turn: ${turnId})`,
                );
              }
              if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
              // Emit event for event-driven handoff in index.js
              this.emit(`tool_call:${turnId}`, json);
            }
          } else if (json.type === "error") {
            if (activeCallbacks.onError) activeCallbacks.onError(json);
          } else if (json.type === "result") {
            // Flush any pending text before the final result event
            if (proc.cleaner) proc.cleaner.flush();

            lastResultJson = json;
            if (json.stats) {
              const { input_tokens, output_tokens, total_tokens } = json.stats;
              console.log(
                `[GeminiController] Turn ${turnId} Usage: In=${input_tokens || 0}, Out=${output_tokens || 0}, Total=${total_tokens || 0}`,
              );
              if ((output_tokens || 0) === 0) {
                console.warn(
                  `[GeminiController] WARNING: Turn ${turnId} generated 0 tokens. This may indicate a safety block or context issue.`,
                );
              }
            }
            // If a quota error was silently swallowed earlier (GEMINI_SILENT_FALLBACK),
            // the CLI emits a 0-token 'result' before exiting with code 1. Treat it
            // as a RATE_LIMIT error so the client gets a proper 429 response instead
            // of an empty success that then has its error silently dropped.
            if (proc.pendingQuotaError) {
              console.warn(
                `[GeminiController] Turn ${turnId}: Intercepting empty result — surfacing pending RATE_LIMIT error to client.`,
              );
              if (activeCallbacks.onError) {
                activeCallbacks.onError(
                  createError(proc.pendingQuotaError, ErrorType.RATE_LIMIT, ErrorCode.RATE_LIMIT_EXCEEDED),
                );
              }
            } else {
              if (activeCallbacks.onResult) activeCallbacks.onResult(json);

              // OPTIMIZATION: Early exit for zero-output success.
              // If the model generated 0 tokens but reports success, we kill the process
              // immediately to trigger the retry loop in index.js without waiting for
              // a potentially slow process termination (which the user reports can take 60s).
              if (json.status === "success" && (json.stats?.output_tokens || 0) === 0) {
                console.log(`[GeminiController] [Turn ${turnId}] Early exit for zero-output success to trigger immediate retry.`);
                proc.isZeroOutputSuccess = true;
                proc.kill("SIGKILL");
              }
            }
          } else if (
            json.type === "tool_result" ||
            json.type === "init" ||
            json.type === "done"
          ) {
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          } else if (json.type === "thought") {
            // [IONOSPHERE] Enhanced JSON Protocol: reasoning_content
            // The bridge maps this to OpenAI's reasoning_content field.
            if (activeCallbacks.onThought) {
              activeCallbacks.onThought(json);
            }
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          } else if (json.type === "citation") {
            // [IONOSPHERE] Enhanced JSON Protocol: citation metadata
            if (activeCallbacks.onCitation) {
              activeCallbacks.onCitation(json);
            }
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          } else if (json.type === "safety") {
            // [IONOSPHERE] Enhanced JSON Protocol: safety/content filter
            console.warn(`[GeminiController] [Turn ${turnId}] ⚠️ Safety block: ${json.reason || 'unknown reason'}`);
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          } else if (json.type === "retry") {
            // [IONOSPHERE] Mid-Stream Fallback: Clear text accumulators for the retry
            console.log(`[GeminiController] [Turn ${turnId}] 🔄 Mid-stream RETRY detected. Clearing text buffers.`);
            if (proc.cleaner) proc.cleaner.flush();
            proc.accumulatedText = "";
            if (activeCallbacks.onRetry) {
              activeCallbacks.onRetry(json);
            }
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          } else if (json.type === "model_info") {
            // [IONOSPHERE] Mid-Stream Fallback: Track model switch
            console.log(`[GeminiController] [Turn ${turnId}] 🤖 Model switched to: ${json.model}`);
            proc.currentModel = json.model;
            if (activeCallbacks.onModelInfo) {
              activeCallbacks.onModelInfo(json);
            }
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          } else {
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
          }
        });

        let rawLogStream = null;
        if (process.env.GEMINI_DEBUG_KEEP_TEMP === "true") {
          try {
            rawLogStream = fs.createWriteStream(
              path.join(workspacePath, "cli_raw_output.txt"),
              { flags: "a" },
            );
          } catch (e) {
            // Ignore
          }
        }

        // [STALL DETECTOR] Reset timer on ANY stdout or stderr activity.
        // This ensures the process is considered "alive" as long as it's emitting tokens,
        // logs, or debug info, even if it hasn't finished a complete JSONL line yet.
        const resetStallTimer = () => {
          if (proc.stallTimer) {
            clearTimeout(proc.stallTimer);
            proc.stallTimer = null;
          }
          // Default to 60s. With Raw IO monitoring enabled, this is safe even for reasoning models,
          // as any chunk or stderr log resets the timer. For aggressive fail-fast, users can 
          // set CLI_STALL_TIMEOUT_MS to 30000.
          const STALL_TIMEOUT_MS = parseInt(process.env.CLI_STALL_TIMEOUT_MS) || 60000;
          proc.stallTimer = setTimeout(() => {
            console.error(
              `[GeminiController] [STALL FATAL] [Turn ${turnId}] No CLI output for ${STALL_TIMEOUT_MS / 1000}s. Killing stalled process.`,
            );
            proc.isStalled = true;
            proc.kill("SIGKILL");
          }, STALL_TIMEOUT_MS);
        };

        // Initially arm it (will be reset/re-armed on data)
        resetStallTimer();

        // NOTE: stdout -> accumulator.push is ALREADY wired in the cold-spawn
        // block (line ~376) or in replenishPool() for warm processes.
        // Adding another listener here caused every chunk to be pushed TWICE,
        // which duplicated all response text.  We only add the rawLogStream
        // writer here (the unique concern of this block).
        if (rawLogStream) {
          proc.stdout.on("data", (chunk) => {
            resetStallTimer();
            rawLogStream.write(chunk);
          });
        } else {
          proc.stdout.on("data", () => resetStallTimer());
        }

        let lastStderr = "";
        let lastStderrLines = [];
        proc.stderr.on("data", (chunk) => {
          resetStallTimer();
          const stderrText = chunk.toString().trim();
          if (stderrText) {
            lastStderrLines.push(stderrText);
            if (lastStderrLines.length > 5) lastStderrLines.shift();

            lastStderr = stderrText.split("\n").slice(-3).join("\n"); // Keep last 3 lines
            const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
            console.error(`[Gemini CLI STDERR] [Turn ${turnId}] ${stderrText}`);

            const errorResult = this.errorParser.parseStderr(
              stderrText,
              activeCallbacks,
            );
            if (errorResult?.type === "FATAL") {
              console.log(`[DEBUG] GeminiController: Received FATAL from parseStderr. Killing process ${proc.pid}`);
              proc.kill("SIGKILL");
            } else if (errorResult?.type === "IGNORE") {
              // The CLI will still emit a 0-token 'result' and exit with code 1.
              // Store the real error so the result handler can surface it properly
              // instead of treating the empty result as a success.
              proc.pendingQuotaError = errorResult.message;
            }
          }
        });

        proc.on("close", (code) => {
          if (rawLogStream) {
            rawLogStream.end();
          }
          if (proc.stallTimer) {
            clearTimeout(proc.stallTimer);
            proc.stallTimer = null;
          }
          clearTimeout(timeout);
          const usageSummary =
            Array.from(this.processes.get(turnId)?.toolUsage || []).join(
              ", ",
            ) || "none";
          console.log(
            `[GeminiController] Process closed for turn ${turnId} with code ${code}. Tool Usage: [${usageSummary}]`,
          );

          // Capture perf timing for the CLI execution phase
          if (PERF_ENABLED) {
            proc._perfCloseTime = performance.now();
            proc._perfTotalCliMs = proc._perfCloseTime - (proc._perfPromiseStart || proc._perfCloseTime);
            if (proc._perfFirstTextTime) {
              proc._perfFirstTextMs = proc._perfFirstTextTime - (proc._perfPromiseStart || proc._perfFirstTextTime);
            }
          }

          // CRITICAL: Flush cleaner BEFORE deleting process/callbacks
          // so that any remaining buffered text reaches the response.
          if (proc.cleaner) proc.cleaner.flush();

          if (accumulator.buffer) {
            accumulator.push("\n");
          }

          // Clean up history file before deleting process reference
          if (proc._historyFilePath) {
            try { fs.unlinkSync(proc._historyFilePath); } catch (_) {}
          }

          this.processes.delete(turnId);

          if (code === 0 || code === null || proc.isZeroOutputSuccess) {
            // After successful completion, check for across-turn repetition
            const fingerprint =
              proc.extraEnv?.IONOSPHERE_HISTORY_HASH || turnId;
            const fullText = proc.accumulatedText || "";
            this.repetitionBreaker.trackTurnResult(fingerprint, fullText);

            // Attach perf data to the result before resolving, since the
            // process reference is deleted by this point and index.js can't
            // read it from controller.processes.get() anymore.
            const resultWithPerf = lastResultJson || {};
            resultWithPerf._perf = {
              spawnMethod: proc._perfSpawnMethod || 'unknown',
              spawnMs: proc._perfSpawnMs || 0,
              firstTextMs: proc._perfFirstTextMs || 0,
              totalCliMs: proc._perfTotalCliMs || 0,
              stdinPayloadBytes: proc._perfStdinPayloadBytes || 0,
            };
            resolve(resultWithPerf);
          } else {
            const diagnostics = lastStderrLines.join("\n").trim();
            let errorMsg = diagnostics
              ? `CLI failed (code ${code}): ${diagnostics}`
              : `CLI process exited with code ${code}`;

            if (proc.isStalled) {
              errorMsg = `CLI stalled during turn ${turnId} (No output for 60s)`;
            }

            reject(new Error(errorMsg));
          }
        });

        proc.on("error", (err) => {
          if (proc.stallTimer) {
            clearTimeout(proc.stallTimer);
            proc.stallTimer = null;
          }
          clearTimeout(timeout);
          this.processes.delete(turnId);
          // NOTE: Do NOT delete callbacksByTurn here — the catch block needs
          // to read them to call onError. The finally block handles cleanup.
          reject(new Error(`Failed to spawn CLI: ${err.message}`));
        });
      });

      return result;
    } catch (err) {
      console.error(`[GeminiController] Turn error: ${err.message}`);
      // Grab callbacks BEFORE finally runs and deletes them
      const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(err.message, ErrorType.SERVER, ErrorCode.INTERNAL_ERROR),
        );
      // Re-throw so the caller (index.js) knows this turn failed.
      // Without this, sendPrompt() resolves to undefined and index.js
      // silently sends an empty success response to the OpenAI client.
      throw err;
    } finally {
      this.callbacksByTurn.delete(turnId);
    }
  }

  /**
   * Cancels a running process.
   */
  cancelCurrentTurn(turnId) {
    const proc = this.processes.get(turnId);
    if (proc) {
      console.log(`[GeminiController] Cancelling turn ${turnId}`);
      proc.isCancelled = true;
      proc.kill("SIGINT");
      // Fallback for unresponsive CLI
      setTimeout(() => {
        if (this.processes.has(turnId)) {
          console.warn(
            `[GeminiController] Turn ${turnId} unresponsive to SIGINT, sending SIGKILL.`,
          );
          try {
            proc.kill("SIGKILL");
          } catch (_) {}
        }
      }, 2000);
      this.processes.delete(turnId);
      this.callbacksByTurn.delete(turnId);
    }
  }

  /**
   * Returns an anti-repetition directive string if the model has been
   * producing repeated text for the given fingerprint. Returns empty string otherwise.
   * Called by index.js before sendPrompt() to break repetition loops.
   */
  getRepeatMitigation(fingerprint) {
    return this.repetitionBreaker.getMitigationDirective(fingerprint);
  }

  /**
   * Terminate all active processes.
   */
  destroyAll() {
    for (const [turnId, proc] of this.processes.entries()) {
      try {
        proc.kill("SIGKILL");
      } catch (_) {}
    }
    this.processes.clear();
    this.callbacksByTurn.clear();
  }
}
