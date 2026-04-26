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
import { RetryableError } from "./errorHandler.js";

const PERF_ENABLED = process.env.GEMINI_PERF_TIMING === "true";
const GEMINI_DEBUG_HANDOFF = process.env.GEMINI_DEBUG_HANDOFF === "true";

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
       if (proc.resetStallTimer) proc.resetStallTimer();
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
    const prev = this.callbacksByTurn.get(turnId);
    if (GEMINI_DEBUG_HANDOFF) {
      console.log(`[GeminiController] [Turn ${turnId}] HIJACK: Updating callbacks. Previous: ${!!prev}, HijackedFrom: ${callbacks.hijackedFrom || 'none'}`);
      if (prev && !prev.hijackedFrom && callbacks.hijackedFrom) {
        console.log(`[GeminiController] [Turn ${turnId}] HIJACK SUCCESS: Link established from Request ${callbacks.hijackedFrom}`);
      }
    }
    this.callbacksByTurn.set(turnId, callbacks);

    if (extraEnv) {
      const proc = this.processes.get(turnId);
      if (proc) {
        // Sync historical context into the running process tracker
        proc.extraEnv = { ...(proc.extraEnv || {}), ...extraEnv };
      }
    }

    if (prev) {
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

      // Calculate dynamic stall timeout based on prompt size to prevent false-positives
      // during long context prefill phases.
      // Formula: max(floor, min(ceiling, base + (input_tokens * factor)))
      const structLen = (structuredContents && Array.isArray(structuredContents)) ? JSON.stringify(structuredContents).length : 0;
      const rawLen = (text && typeof text === 'string') ? text.length : 0;
      const payloadChars = Math.max(structLen, rawLen);
      
      const estimatedTokens = Math.max(100, payloadChars / 3); // Floor of 100 tokens
      const msPerToken = parseFloat(process.env.CLI_STALL_MS_PER_TOKEN) || 10; // Increased from 1.5 for reasoning
      const baseStall = parseInt(process.env.CLI_STALL_TIMEOUT_MS) || 180000; // Increased from 120000 for complex turns
      
      const dynamicStallTimeout = Math.max(
        baseStall,
        Math.min(900000, baseStall + Math.round(estimatedTokens * msPerToken))
      );


      
      if (dynamicStallTimeout > baseStall || process.env.GEMINI_DEBUG_PROMPTS === "true") {
        console.log(`[GeminiController] [Turn ${turnId}] Dynamic Stall Timeout: ${dynamicStallTimeout}ms (Base: ${baseStall}ms, Estimated Tokens: ${Math.round(estimatedTokens)})`);
      }

      const result = await new Promise((resolve, reject) => {
        const promiseStartTime = PERF_ENABLED ? performance.now() : 0;
        let lastResultJson = null;
        let proc = null;
        let accumulator = null;
        let stallTimer = null;
        
        const resetStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (this.processes.has(turnId)) {
               console.error(`[GeminiController] [Turn ${turnId}] STALL: No output from CLI for ${dynamicStallTimeout}ms. Killing process.`);
               const p = this.processes.get(turnId);
               if (p) {
                 p.isStallKill = true;
                 p.kill("SIGKILL");
               }
            }
          }, dynamicStallTimeout);

        };
        
        // Expose to proc for manual resets via IPC/Bridge
        const attachStallProtection = (p) => {
          p.resetStallTimer = resetStallTimer;
          resetStallTimer();
        };

        const currentPool = this.warmPool.get(hashKey) || [];
        if (currentPool.length > 0) {
          const readyIdx = currentPool.findIndex(p => p.isWarm);
          if (readyIdx !== -1) {
            proc = currentPool.splice(readyIdx, 1)[0];
            accumulator = proc.warmAccumulator;
            proc._perfSpawnMethod = "warm";
            attachStallProtection(proc);
            console.log(`[GeminiController] Acquired WARM process from pool!`);
          } else {
            // Case: Process is still 'warming' (waiting for INIT).
            // Instead of cold-spawning, we wait briefly for it to become warm.
            proc = currentPool.shift();
            accumulator = proc.warmAccumulator;
            proc._perfSpawnMethod = "warming";
            attachStallProtection(proc);
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
          
          attachStallProtection(proc);
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
            if (proc.resetStallTimer) proc.resetStallTimer();
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
        proc.currentPhase = historyFilePath ? "sending_file_stub" : "uploading_prompt";
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
          }

          // [IONOSPHERE] Forensic: Track latency from tool result to resume
          if (proc.lastResultInjectedAt) {
             const resumeLatency = Date.now() - proc.lastResultInjectedAt;
             console.log(`[GeminiController] [Turn ${turnId}] Resume latency: ${resumeLatency}ms after tool result (Phase: ${proc.currentPhase})`);
             delete proc.lastResultInjectedAt;
             proc.currentPhase = "executing";
          } else if (json.type !== "message" || process.env.GEMINI_DEBUG_RAW === "true") {
            console.log(
              `[Turn ${turnId}] CLI Raw Line: ${json.type}${json.role ? " [" + json.role + "]" : ""}`,
            );
          }
          
          if (json.type === "message") {
            const contentObj = json.content || {};
            const thought = contentObj.thought || contentObj.thinking || json.thinking;
            if (thought) {
              console.log(`[GeminiController] [Turn ${turnId}] 🧠 DETECTED REASONING/THOUGHT tokens in message.`);
              // [IONOSPHERE] Reasoning Loop Watchdog for embedded thoughts
              if (this.repetitionBreaker.checkReasoningRepetition(
                proc,
                { type: "thought", content: thought, summary: json.summary || "" },
                turnId,
                activeCallbacks
              )) {
                proc.kill("SIGKILL");
                return;
              }
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
              const err = new RetryableError(
                `Turn ${turnId} killed due to repetition loop.`,
                "repetition_breaker",
                0,
                true // isRepetitionKill
              );
              // Store it on the proc so sendPrompt can catch it
              proc.pendingRetryError = err; 
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
            // [IONOSPHERE] Heartbeat: Monitor for event loop lockup during large turn cleanup
            console.log(`[GeminiController] [Turn ${turnId}] Final result received. Entering final repetition check (flush)...`);
            if (proc.cleaner) {
              try {
                this.repetitionBreaker.finalize(proc);
                proc.cleaner.flush();
                console.log(`[GeminiController] [Turn ${turnId}] Final repetition check (flush) complete.`);
              } catch (e) {
                console.error(`[GeminiController] [Turn ${turnId}] CRITICAL: Repetition check failed: ${e.message}`);
              }
            }

            lastResultJson = json;
            if (json.stats) {
              const { input_tokens, output_tokens, total_tokens } = json.stats;
              const textLen = (proc.accumulatedText || "").trim().length;
              
              console.log(
                `[GeminiController] Turn ${turnId} Usage: In=${input_tokens || 0}, Out=${output_tokens || 0}, Total=${total_tokens || 0} (Content Chars: ${textLen})`,
              );
              
              if ((output_tokens || 0) === 0 || (output_tokens > 0 && textLen === 0)) {
                console.warn(
                  `[GeminiController] WARNING: Turn ${turnId} generated 0 content tokens${textLen === 0 && output_tokens > 0 ? " (Reasoning only)" : ""}. This may indicate a safety block or context issue.`,
                );
              }
            }
            // If a quota error was silently swallowed earlier (GEMINI_SILENT_FALLBACK),
            // the CLI emits a 0-token 'result' before exiting with code 1. Treat it
            // as a RATE_LIMIT error so the client gets a proper 429 response instead
            // of an empty success that then has its error silently dropped.
            if (proc.pendingQuotaError) {
              // If GEMINI_SILENT_FALLBACK is enabled, we skip calling onError here.
              // This allows the orchestrator (index.js) to catch the final process 
              // failure and trigger its own retry/fallback logic before the client 
              // is notified of a terminal error.
              if (process.env.GEMINI_SILENT_FALLBACK === "true") {
                console.warn(
                  `[GeminiController] Turn ${turnId}: Quota error detected, but SILENT_FALLBACK is active. Suppressing proactive onError and awaiting process close.`,
                );
              } else {
                console.warn(
                  `[GeminiController] Turn ${turnId}: Intercepting empty result — surfacing pending RATE_LIMIT error to client.`,
                );
                if (activeCallbacks.onError) {
                  activeCallbacks.onError(
                    createError(proc.pendingQuotaError, ErrorType.RATE_LIMIT, ErrorCode.RATE_LIMIT_EXCEEDED),
                  );
                }
              }
            } else {
              if (activeCallbacks.onResult) activeCallbacks.onResult(json);
              
              // [IONOSPHERE] Result Watchdog: Force exit if CLI hangs after emitting result
              console.log(`[GeminiController] [Turn ${turnId}] Final result received. Initiating 5s graceful exit watchdog.`);
              proc._exitWatchdog = setTimeout(() => {
                if (this.processes.has(turnId)) {
                   console.warn(`[GeminiController] [Turn ${turnId}] CLI hung for 5s after 'result' event. SIGKILLing to unblock.`);
                   const p = this.processes.get(turnId);
                   if (p) p.kill("SIGKILL");
                }
              }, 5000);

              // OPTIMIZATION: Early exit for zero-output success.
              // If the model generated 0 tokens (or only reasoning tokens) but reports success, 
              // we kill the process immediately to trigger the retry loop in index.js.
              const hasNoContent = ((json.stats?.output_tokens || 0) === 0 || (proc.accumulatedText || "").trim().length === 0) && (proc.toolUsage?.size || 0) === 0;
              
              if (json.status === "success" && hasNoContent) {
                console.log(`[GeminiController] [Turn ${turnId}] Early exit for zero-content success to trigger immediate retry.`);
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
            // [IONOSPHERE] Reasoning Loop Watchdog
            if (this.repetitionBreaker.checkReasoningRepetition(
              proc,
              json,
              turnId,
              this.callbacksByTurn.get(turnId) || {},
            )) {
              proc.kill("SIGKILL");
              return;
            }

            if (activeCallbacks.onThought) {
              activeCallbacks.onThought(json);
            }
            if (activeCallbacks.onEvent) {
              activeCallbacks.onEvent(json);
            }
            resetStallTimer(); // Reset stall timer on reasoning progress
          } else if (json.type === "citation") {
            // [IONOSPHERE] Enhanced JSON Protocol: citation metadata
            if (activeCallbacks.onCitation) {
              activeCallbacks.onCitation(json);
            }
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
            resetStallTimer(); 
          } else if (json.type === "safety") {
            // [IONOSPHERE] Enhanced JSON Protocol: safety/content filter
            console.warn(`[GeminiController] [Turn ${turnId}] ⚠️ Safety block: ${json.reason || 'unknown reason'}`);
            // Explicitly notify orchestrator that this was a safety refusal
            if (activeCallbacks.onSafety) {
              activeCallbacks.onSafety(json);
            }
            if (activeCallbacks.onEvent) activeCallbacks.onEvent(json);
            resetStallTimer();
          } else if (json.type === "message" || json.type === "tool_use" || json.type === "toolCall") {
            resetStallTimer(); // Reset stall timer on any meaningful content/action
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

        // [IONOSPHERE] The stall detector is now initialized and managed 
        // at the top of sendPrompt via attachStallProtection().
        // No redundant definition needed here.


        // Expose the reset function so the orchestrator can keep us alive while parked
        proc.resetStallTimer = resetStallTimer;

        // Initially arm it (will be reset/re-armed on data)
        resetStallTimer();

        // NOTE: stdout -> accumulator.push is ALREADY wired in the cold-spawn
        // block (line ~376) or in replenishPool() for warm processes.
        // Adding another listener here caused every chunk to be pushed TWICE,
        // which duplicated all response text.  We only add the rawLogStream
        // writer here (the unique concern of this block).
        if (rawLogStream) {
          proc.stdout.on("data", (chunk) => {
            // STALL DETECTION: Only reset on "line" events (model progress) in strict mode.
            // Raw data reset is moved to accumulator JSONL parsing logic to avoid
            // CLI logs ("Still waiting") from masking a genuine model stall.
            rawLogStream.write(chunk);
          });
        }

        let lastStderrLines = [];
        proc.stderr.on("data", (chunk) => {
          // STALL DETECTION: Reset timer on ANY stderr activity too.
          // This ensures that periodic CLI meta-logs like "Still waiting" 
          // don't prevent the stall detector from killing a stuck model.
          if (resetStallTimer) resetStallTimer();

          const stderrText = chunk.toString().trim();
          if (stderrText) {
            lastStderrLines.push(stderrText);
            if (lastStderrLines.length > 5) lastStderrLines.shift();

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

        const onCleanup = (code) => {
          // Prevent double-cleanup
          if (!this.processes.has(turnId)) return;

          // [IONOSPHERE] Proactive Hijack Notification (Moved to top for reliability)
          const activeCallbacks = this.callbacksByTurn.get(turnId);
          const isError = (code !== 0 && code !== null) || proc.pendingRetryError || proc.pendingQuotaError;
          if (isError && activeCallbacks && activeCallbacks.hijackedFrom && activeCallbacks.onError) {
             console.log(`[GeminiController] [Turn ${turnId}] Target process died while hijacked (code ${code}). Notifying hijacking request.`);
             activeCallbacks.onError(createError(proc.pendingRetryError?.message || proc.pendingQuotaError || "Target process died", ErrorType.SERVER, ErrorCode.INTERNAL_ERROR));
          }

          if (rawLogStream) {
            rawLogStream.end();
          }
          if (proc.stallTimer) {
            clearTimeout(proc.stallTimer);
            proc.stallTimer = null;
          }
          if (proc._exitWatchdog) {
            clearTimeout(proc._exitWatchdog);
            proc._exitWatchdog = null;
          }
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
          clearTimeout(timeout);
          const procRef = this.processes.get(turnId);
          const usageSummary =
            Array.from(procRef?.toolUsage || []).join(
              ", ",
            ) || "none";
          console.log(
            `[GeminiController] Process closed for turn ${turnId} with code ${code}. Tool Usage: [${usageSummary}]`,
          );

          this.processes.delete(turnId);
          this.emit("turn_closed", turnId);

          if (PERF_ENABLED) {
            proc._perfCloseTime = performance.now();
            proc._perfTotalCliMs = proc._perfCloseTime - (proc._perfPromiseStart || proc._perfCloseTime);
            if (proc._perfFirstTextTime) {
              proc._perfFirstTextMs = proc._perfFirstTextTime - (proc._perfPromiseStart || proc._perfCloseTime);
            }
          }

          if (proc.cleaner) proc.cleaner.flush();

          if (accumulator.buffer) {
            const lastLine = accumulator.buffer.trim();
            if (lastLine) {
              try {
                const json = JSON.parse(lastLine);
                accumulator.emit("line", json);
              } catch (e) {
                // Ignore final parse error
              }
            }
          }

          if (proc._historyFilePath) {
            try { fs.unlinkSync(proc._historyFilePath); } catch (_) {}
          }

          // Cancelled turns (e.g. client disconnect grace period) resolve
          // cleanly so executeTask completes and currentlyRunning decrements.
          if (proc.isCancelled) {
            resolve(null);
            return;
          }

          // [IONOSPHERE] Unified Retry Signaling
          if (proc.isStallKill) {
            reject(new RetryableError(`CLI stalled (no output for ${dynamicStallTimeout}ms)`, "stall"));
            return;
          }

          if (proc.pendingRetryError) {

            reject(proc.pendingRetryError);
            return;
          }

          if (proc.pendingQuotaError) {
            reject(new RetryableError(proc.pendingQuotaError, "quota", 0, false, false, true));
            return;
          }

          if (code === 0) {
            const resultWithPerf = lastResultJson || {};
            resultWithPerf._perf = {
              spawnMethod: proc._perfSpawnMethod || 'unknown',
              spawnMs: proc._perfSpawnMs || 0,
              firstTextMs: proc._perfFirstTextMs || 0,
              totalCliMs: proc._perfTotalCliMs || 0,
              stdinPayloadBytes: proc._perfStdinPayloadBytes || 0,
            };
            
            const fingerprint = proc.extraEnv?.IONOSPHERE_HISTORY_HASH || turnId;
            this.repetitionBreaker.finalize(proc);
            const fullText = proc.accumulatedText || "";
            this.repetitionBreaker.trackTurnResult(fingerprint, fullText);
            resolve(resultWithPerf);
          } else if (proc.isZeroOutputSuccess) {
            reject(new RetryableError("Zero output success detected", "zero_output"));
          } else {
            const diagnostics = lastStderrLines.join("\n").trim();
            const errorMsg = diagnostics ? `CLI failed (code ${code}): ${diagnostics}` : `CLI process exited with code ${code}`;
            // Heuristic for quota in generic failures
            if (/429|Quota|Capacity/i.test(errorMsg)) {
              reject(new RetryableError(errorMsg, "quota", 0, false, false, true));
            } else {
              reject(new Error(errorMsg));
            }
          }
        };

        proc.on("close", onCleanup);
        proc.on("exit", onCleanup);

        proc.on("error", (err) => {
          if (proc.stallTimer) {
            clearTimeout(proc.stallTimer);
            proc.stallTimer = null;
          }
          clearTimeout(timeout);
          this.processes.delete(turnId);
          // NOTE: Do NOT delete callbacksByTurn here — the catch block needs
          // to read them to call onError. The finally block handles cleanup.
          
          // [IONOSPHERE] Proactive Hijack Notification
          const activeCallbacks = this.callbacksByTurn.get(turnId);
          if (activeCallbacks && activeCallbacks.hijackedFrom && activeCallbacks.onError) {
            console.log(`[GeminiController] [Turn ${turnId}] Target process spawn error while hijacked. Notifying hijacking request.`);
            activeCallbacks.onError(createError(`Failed to spawn CLI: ${err.message}`, ErrorType.SERVER, ErrorCode.INTERNAL_ERROR));
          }
          reject(new Error(`Failed to spawn CLI: ${err.message}`));
        });
      });

      return result;
    } catch (err) {
      console.error(`[GeminiController] Turn error: ${err.message}`);
      // Grab callbacks BEFORE finally runs and deletes them
      const activeCallbacks = this.callbacksByTurn.get(turnId) || {};

      // Suppression Logic: If this is a RetryableError, do NOT call onError here
      // UNLESS the turn was hijacked. Hijacked turns (Wait-and-Hijack or Handoff)
      // are not part of the orchestrator retry loop and would hang forever 
      // if the error is suppressed.
      const isRetryable = err && (err.name === "RetryableError" || err.isRetryable);
      const isQuotaError = /429|Quota|Capacity|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED/i.test(err.message);
      const isHijacked = !!activeCallbacks.hijackedFrom;
      
      const shouldSuppress = !isHijacked && (isRetryable || (isQuotaError && process.env.GEMINI_SILENT_FALLBACK === "true"));

      if (shouldSuppress) {
        console.warn(`[GeminiController] Turn ${turnId}: ${err.name || 'Error'} caught in sendPrompt. SUPPRESSING (Retryable: ${isRetryable}, Quota: ${isQuotaError}).`);
      } else if (activeCallbacks.onError) {
        console.log(`[GeminiController] Turn ${turnId}: ${err.name || 'Error'} caught in sendPrompt. PROPAGATING to onError (isHijacked: ${isHijacked}).`);
        activeCallbacks.onError(
          createError(err.message, ErrorType.SERVER, ErrorCode.INTERNAL_ERROR),
        );
      } else {
        console.error(`[GeminiController] Turn ${turnId}: ${err.name || 'Error'} caught in sendPrompt, but NO onError callback found!`);
      }
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
  async cancelCurrentTurn(turnId) {
    const proc = this.processes.get(turnId);
    if (proc) {
      proc.currentPhase = "cancelling";
      console.log(`[GeminiController] Cancelling turn ${turnId} (Process ${proc.pid})...`);
      proc.isCancelled = true;
      proc.kill("SIGINT");
      // Fallback for unresponsive CLI
      setTimeout(() => {
        try {
          if (!proc.killed) {
            console.warn(
              `[GeminiController] Turn ${turnId} unresponsive to SIGINT, sending SIGKILL.`,
            );
            proc.kill("SIGKILL");
          }
        } catch (_) {}
      }, 2000);
      // Do NOT delete from this.processes here — let onCleanup handle it
      // when the process actually exits so the promise settles and
      // currentlyRunning is properly decremented.
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
