import { createError, ErrorType, ErrorCode } from "./errorHandler.js";
import fs from "node:fs";

const MAX_REPEAT_TRACKER_SIZE = 100;

/**
 * Manages loop detection and mitigation for Gemini turns.
 * Handles:
 * 1. Tool-call repetition within a single turn.
 * 2. Substring repetition within a single turn's output.
 * 3. Identical full-text responses across sequential turns.
 */
export class RepetitionBreaker {
  constructor() {
    // Map<fingerprint, { text: string, count: number, mitigate: boolean }>
    this.textRepeatTracker = new Map();
  }

  /**
   * Checks if a tool call is repeating excessively within the current process context.
   * Returns 'KILL', 'IGNORE', or false.
   */
  checkToolRepeatLimit(proc, toolName, argsObj, historyHash, historyTools, activeCallbacks) {
    if (!proc) return false;
    
    // MASTER TOGGLE: Allow disabling all repetition breaker logic for stress tests
    if (process.env.GEMINI_DISABLE_REPETITION_BREAKER === "true") return false;

    // Scope repeat tracker to the process/turn to prevent persistence bugs on retries
    if (!proc.repeatTracker) proc.repeatTracker = new Map();

    const toolArgs = JSON.stringify(argsObj || {});
    const key = `${historyHash}:${toolName}:${toolArgs}`;

    // Read historical tools from file if path is provided in extraEnv
    let historyToolsStr = historyTools || "";
    if (proc.extraEnv && proc.extraEnv.IONOSPHERE_HISTORY_TOOLS_PATH) {
      try {
        if (fs.existsSync(proc.extraEnv.IONOSPHERE_HISTORY_TOOLS_PATH)) {
          historyToolsStr = fs.readFileSync(proc.extraEnv.IONOSPHERE_HISTORY_TOOLS_PATH, "utf-8");
        }
      } catch (e) {
        console.error(`[RepetitionBreaker] Failed to read historical tools from path: ${e.message}`);
      }
    }

    // Check if this is a "historical" tool call being parroted
    const isHistorical = historyToolsStr.includes(key);

    if (isHistorical) {
      console.log(
        `[RepetitionBreaker] [FORENSICS] Tool '${toolName}' identified as historical echo. Ignoring.`,
      );
      return "IGNORE";
    }

    const entry = proc.repeatTracker.get(key) || { count: 0, graceUsed: 0 };
    entry.count++;
    proc.repeatTracker.set(key, entry);

    const graceCount = parseInt(process.env.REPEAT_GRACE_COUNT) || 2;
    const maxRepeats = parseInt(process.env.MAX_REPEAT_TOOL_CALLS) || 0;

    // Grace window: allow the first N retries without escalation
    if (entry.count <= graceCount) {
      console.log(
        `[RepetitionBreaker] [RETRY] Tool '${toolName}' retry ${entry.count}/${graceCount} (grace period). Allowing.`,
      );
      return false;
    }

    // After grace is exhausted, count toward the kill threshold
    const effectiveCount = entry.count - graceCount;

    if (maxRepeats > 0 && effectiveCount >= maxRepeats) {
      const errorMsg = `Loop detected: Model repeated tool '${toolName}' with same arguments ${entry.count} times (${graceCount} grace + ${effectiveCount} violations).`;
      console.error(`[RepetitionBreaker] ${errorMsg} Terminating process.`);
      
      if (activeCallbacks.onError) {
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.POLICY_DENIED)
        );
      }
      if (activeCallbacks.onResult) {
        activeCallbacks.onResult({ type: "result", text: errorMsg, stats: {} });
      }
      return "KILL";
    }
    return false;
  }

  /**
   * Checks for substring repetition within a single turn.
   * Returns true if a loop is detected and the process should be killed.
   */
  checkTextRepetition(proc, text, turnId, activeCallbacks) {
    proc.accumulatedText = (proc.accumulatedText || "") + text;
    const accumulated = proc.accumulatedText;

    // MASTER TOGGLE: Allow disabling all repetition breaker logic for stress tests
    if (process.env.GEMINI_DISABLE_REPETITION_BREAKER === "true") return false;

    // Check 1: S+S full-response echo detection (catches 2-occurrence full duplications)
    const echoResult = this.checkFullEcho(accumulated);
    if (echoResult) {
      console.error(
        `[RepetitionBreaker] FULL ECHO DETECTED: Turn ${turnId} is repeating its own output from the beginning. ` +
        `Echo starts at char ${echoResult.echoStart} of ${accumulated.length} (${echoResult.overlapPct}% overlap).`,
      );
      // Truncate accumulated text to just the unique portion
      proc.accumulatedText = accumulated.slice(0, echoResult.echoStart);
      if (activeCallbacks.onError) {
        activeCallbacks.onError({
          message: `Response terminated: Model echoed its own full response.`,
          type: "server_error",
          code: "repetition_loop",
        });
      }
      return true; // Signal to kill process
    }
    
    // Check 2: Original N-occurrence block repetition
    if (accumulated.length > 600) {
      const checkLen = parseInt(process.env.REPETITION_BLOCK_SIZE) || 200;
      const tail = accumulated.slice(-checkLen);
      
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = accumulated.indexOf(tail, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + 1;
      }
      
      const threshold = parseInt(process.env.REPETITION_THRESHOLD) || 3;

      if (count >= threshold) {
        console.error(
          `[RepetitionBreaker] WITHIN-TURN REPETITION: Turn ${turnId} repeated ${checkLen}-char block ${count} times.`,
        );
        if (activeCallbacks.onError) {
          activeCallbacks.onError({
            message: `Response terminated: Model entered a text repetition loop.`,
            type: "server_error",
            code: "repetition_loop",
          });
        }
        return true; // Signal to kill process
      }
    }
    return false;
  }

  /**
   * Checks for reasoning repetition or "thought hallucination" during the thinking phase.
   * Returns true if a loop/collapse is detected and the process should be killed.
   */
  checkReasoningRepetition(proc, json, turnId, activeCallbacks) {
    // MASTER TOGGLE: Allow disabling all repetition breaker logic for stress tests
    if (process.env.GEMINI_DISABLE_REPETITION_BREAKER === "true") return false;

    // 0. Global Reasoning Step Limit (Safety Net)
    if (!proc.reasoningSteps) proc.reasoningSteps = 0;
    proc.reasoningSteps++;

    const maxSteps = parseInt(process.env.MAX_REASONING_STEPS) || 50;
    if (proc.reasoningSteps > maxSteps) {
      const errorMsg = `Response terminated: Model exceeded the global reasoning limit (${maxSteps} steps). This usually indicates a stuck thinking process.`;
      console.error(`[RepetitionBreaker] THOUGHT LIMIT EXCEEDED: Turn ${turnId} reached ${proc.reasoningSteps} steps.`);
      if (activeCallbacks.onError) {
        activeCallbacks.onError({
          message: errorMsg,
          type: "server_error",
          code: "reasoning_limit_reached",
        });
      }
      return true;
    }

    // 1. Summary Repetition Detection
    // Catches "cycling" loops where the model changes content but keeps the same higher-level intent.
    const summary = json.summary || "";
    if (summary && summary.length > 5) {
      if (!proc.summaryMap) proc.summaryMap = new Map();
      const sCount = (proc.summaryMap.get(summary) || 0) + 1;
      proc.summaryMap.set(summary, sCount);

      const sThreshold = parseInt(process.env.REPETITION_THRESHOLD) || 3;
      if (sCount >= sThreshold) {
        const errorMsg = `Response terminated: Model repeated the same reasoning summary ('${summary}') ${sCount} times.`;
        console.error(`[RepetitionBreaker] IDENTICAL SUMMARY DETECTED: Turn ${turnId} for summary: "${summary}"`);
        if (activeCallbacks.onError) {
          activeCallbacks.onError({
            message: errorMsg,
            type: "server_error",
            code: "reasoning_loop",
          });
        }
        return true;
      }
    }

    const content = typeof json.content === "string" ? json.content : (json.thought || "");
    if (!content || content.length < 10) return false; // Ignore empty or trivial thoughts for the exact-content/substring checks

    // 2. Exact Content Repetition Detection (Content-Agnostic)
    // Most reasoning loops repeat the exact same content block.
    if (!proc.thoughtMap) proc.thoughtMap = new Map();
    
    const count = (proc.thoughtMap.get(content) || 0) + 1;
    proc.thoughtMap.set(content, count);

    const threshold = parseInt(process.env.REPETITION_THRESHOLD) || 3;
    if (count >= threshold) {
      console.error(
        `[RepetitionBreaker] IDENTICAL THOUGHT DETECTED: Turn ${turnId} repeated the exact same reasoning block ${count} times.`,
      );
      if (activeCallbacks.onError) {
        activeCallbacks.onError({
          message: `Response terminated: Model entered an identical reasoning loop.`,
          type: "server_error",
          code: "reasoning_loop",
        });
      }
      return true; // Kill immediately
    }

    // 2. Substring repetition in thoughts (Secondary Defense)
    // Catches loops with slight variations (e.g. timestamps or random nonces).
    proc.accumulatedThoughts = (proc.accumulatedThoughts || "") + content;
    const accumulated = proc.accumulatedThoughts;

    if (accumulated.length > 500) {
      const checkLen = 150;
      const tail = accumulated.slice(-checkLen);
      
      let subCount = 0;
      let searchFrom = 0;
      while (true) {
        const idx = accumulated.indexOf(tail, searchFrom);
        if (idx === -1) break;
        subCount++;
        searchFrom = idx + 1;
      }

      if (subCount >= 3) {
        console.error(
          `[RepetitionBreaker] REASONING SUBSTRING LOOP: Turn ${turnId} repeated ${checkLen}-char block ${subCount} times in thoughts.`,
        );
        if (activeCallbacks.onError) {
          activeCallbacks.onError({
            message: `Response terminated: Model entered a reasoning repetition loop.`,
            type: "server_error",
            code: "reasoning_loop",
          });
        }
        return true; // Kill immediately
      }
    }

    return false;
  }

  /**
   * Detects "S+S" full-response echo: the model generates a complete response,
   * then starts streaming the same content again from the beginning.
   * 
   * Returns { echoStart, overlapPct } if echo is detected, or null otherwise.
   * 
   * Algorithm: Starting from the midpoint of the accumulated text, check if
   * the suffix starting at each candidate position matches the prefix of the
   * accumulated text. If so, and the match is long enough (≥40% of the original),
   * we've found an echo.
   */
  checkFullEcho(accumulated) {
    const MIN_LENGTH = 300; // Don't check until we have enough text
    const MIN_OVERLAP_PCT = 40; // Require ≥40% of the first half to match
    const PROBE_LENGTH = 80; // Length of the prefix probe to search for

    if (accumulated.length < MIN_LENGTH) return null;

    // Take the first PROBE_LENGTH characters as our "fingerprint" of the response start
    const probe = accumulated.slice(0, PROBE_LENGTH);
    
    // Search for the probe appearing again in the second half of the text
    // Start searching from 40% of the way through (the echo can't start before that)
    const searchStart = Math.floor(accumulated.length * 0.4);
    let echoStart = accumulated.indexOf(probe, searchStart);

    while (echoStart !== -1) {
      // Found a candidate. Verify: does the text from echoStart match the beginning?
      const echoLength = accumulated.length - echoStart;
      const originalPrefix = accumulated.slice(0, echoLength);
      const echoPortion = accumulated.slice(echoStart);

      if (echoPortion === originalPrefix) {
        const overlapPct = Math.round((echoLength / echoStart) * 100);
        if (overlapPct >= MIN_OVERLAP_PCT) {
          return { echoStart, overlapPct };
        }
      }

      // Try next occurrence
      echoStart = accumulated.indexOf(probe, echoStart + 1);
    }

    return null;
  }

  /**
   * Tracks response text after a successful turn to detect across-turn loops.
   */
  trackTurnResult(fingerprint, fullText) {
    if (!fullText || fullText.length <= 50) return;

    const lastEntry = this.textRepeatTracker.get(fingerprint);
    if (lastEntry && lastEntry.text === fullText.trim()) {
      lastEntry.count++;
      lastEntry.mitigate = true;
      console.warn(
        `[RepetitionBreaker] REPEAT DETECTED for ${fingerprint}: Same text ${lastEntry.count} times.`,
      );
    } else {
      if (this.textRepeatTracker.size >= MAX_REPEAT_TRACKER_SIZE) {
        const firstKey = this.textRepeatTracker.keys().next().value;
        this.textRepeatTracker.delete(firstKey);
      }
      this.textRepeatTracker.set(fingerprint, {
        text: fullText.trim(),
        count: 1,
        mitigate: false,
      });
    }
  }

  /**
   * Returns a directive to break identified repetition loops.
   */
  getMitigationDirective(fingerprint) {
    const entry = this.textRepeatTracker.get(fingerprint);
    if (entry && entry.mitigate && entry.count >= 2) {
      const severity = entry.count >= 3 ? "CRITICAL" : "WARNING";
      entry.mitigate = false; // Reset flag after one mitigation attempt
      return `\n\n[SYSTEM ${severity}: Your previous ${entry.count} responses were IDENTICAL. This is a repetition loop. You MUST provide a substantially DIFFERENT response. Do NOT repeat the same text. If you are stuck, acknowledge the issue and ask the user for clarification instead of repeating yourself.]\n`;
    }
    return "";
  }
}
