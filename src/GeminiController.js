import { spawn } from "child_process";
import EventEmitter from "events";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";

import { createError, ErrorType, ErrorCode } from "./errorHandler.js";
import { RepetitionBreaker } from "./RepetitionBreaker.js";
import { CliRunner } from "./CliRunner.js";
import { CliErrorParser } from "./CliErrorParser.js";

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
    // Regexes used for cleaning.
    // IMPORTANT: 'resultRegex' lookahead must NOT include '$' unless it's the final flush,
    // otherwise it will consume trailing text as if it were part of a result tag.
    const actionRegex =
      /\[Action \(id: ([^)]*)\): Called tool '([^']+)' with args: (.*?)\]/gs;
    const lookahead = isFinal
      ? "(?=\\n\\n|\\[Action|\\[Tool Result|USER:|$)"
      : "(?=\\n\\n|\\[Action|\\[Tool Result|USER:)";
    const resultRegex = new RegExp(
      `\\[Tool Result \\(id: ([^)]*)\\)\\]:[^]*?${lookahead}`,
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

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
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

      // Structured History Mode: pipe Content[] JSON instead of flat text
      if (structuredContents) {
        extraEnv.IONOSPHERE_STRUCTURED_HISTORY = "true";
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
        await fsp.writeFile(
          path.join(debugDir, `turn-${turnId}-prompt.txt`),
          text,
          "utf-8",
        );
        if (systemPromptPath) {
          await fsp.copyFile(
            systemPromptPath,
            path.join(debugDir, `turn-${turnId}-system.md`),
          );
        }
      }

      console.log(
        `[GeminiController] Spawning stateless CLI: ${executable} ${finalArgs.join(" ")}`,
      );

      const result = await new Promise((resolve, reject) => {
        const accumulator = new JsonlAccumulator();
        let lastResultJson = null;

        const spawnEnv = this.cliRunner.prepareEnv(
          settingsPath,
          extraEnv,
          systemPromptPath,
        );

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

        const proc = spawn(executable, finalArgs, {
          cwd: workspacePath,
          env: spawnEnv,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        });

        // Write prompt content to stdin and signal EOF
        const stdinContent = structuredContents
          ? JSON.stringify(structuredContents)
          : text;
        proc.stdin.end(stdinContent, "utf-8");

        proc.extraEnv = extraEnv; // Initialize with spawn env
        proc.toolUsage = new Set(); // Track real tool calls in this turn
        proc.accumulatedText = ""; // Track full text for repeat detection
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

        accumulator.on("line", (json) => {
          const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
          proc.activeCallbacks = activeCallbacks; // Shared reference for StreamingCleaner

          if (process.env.GEMINI_DEBUG_RAW === "true") {
            console.log(
              `[Turn ${turnId}] CLI Raw Line: ${JSON.stringify(json)}`,
            );
          } else {
            console.log(
              `[Turn ${turnId}] CLI Raw Line: ${json.type}${json.role ? " [" + json.role + "]" : ""}`,
            );
          }

          if (json.type === "message" && json.role === "assistant") {
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
            if (activeCallbacks.onResult) activeCallbacks.onResult(json);
          } else if (
            json.type === "tool_result" ||
            json.type === "init" ||
            json.type === "done"
          ) {
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

        proc.stdout.on("data", (chunk) => {
          if (rawLogStream) {
            rawLogStream.write(chunk);
          }
          accumulator.push(chunk);
        });

        let lastStderr = "";
        let lastStderrLines = [];
        proc.stderr.on("data", (chunk) => {
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
              proc.kill("SIGKILL");
            }
          }
        });

        proc.on("close", (code) => {
          if (rawLogStream) {
            rawLogStream.end();
          }
          clearTimeout(timeout);
          const usageSummary =
            Array.from(this.processes.get(turnId)?.toolUsage || []).join(
              ", ",
            ) || "none";
          console.log(
            `[GeminiController] Process closed for turn ${turnId} with code ${code}. Tool Usage: [${usageSummary}]`,
          );

          // CRITICAL: Flush cleaner BEFORE deleting process/callbacks
          // so that any remaining buffered text reaches the response.
          if (proc.cleaner) proc.cleaner.flush();

          if (accumulator.buffer) {
            accumulator.push("\n");
          }

          this.processes.delete(turnId);

          if (code === 0 || code === null) {
            // After successful completion, check for across-turn repetition
            const fingerprint =
              proc.extraEnv?.IONOSPHERE_HISTORY_HASH || turnId;
            const fullText = proc.accumulatedText || "";
            this.repetitionBreaker.trackTurnResult(fingerprint, fullText);

            resolve(lastResultJson);
          } else {
            const diagnostics = lastStderrLines.join("\n").trim();
            const errorMsg = diagnostics
              ? `CLI failed (code ${code}): ${diagnostics}`
              : `CLI process exited with code ${code}`;
            reject(new Error(errorMsg));
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          this.processes.delete(turnId);
          this.callbacksByTurn.delete(turnId);
          reject(new Error(`Failed to spawn CLI: ${err.message}`));
        });
      });

      return result;
    } catch (err) {
      console.error(`[GeminiController] Turn error: ${err.message}`);
      const activeCallbacks = this.callbacksByTurn.get(turnId) || {};
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(err.message, ErrorType.SERVER, ErrorCode.INTERNAL_ERROR),
        );
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
