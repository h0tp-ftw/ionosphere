import { createError, ErrorType, ErrorCode } from "./errorHandler.js";

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
    
    // Scope repeat tracker to the process/turn to prevent persistence bugs on retries
    if (!proc.repeatTracker) proc.repeatTracker = new Map();

    const toolArgs = JSON.stringify(argsObj || {});
    const key = `${historyHash}:${toolName}:${toolArgs}`;

    // Check if this is a "historical" tool call being parroted
    const isHistorical = (historyTools || "").includes(key);

    if (isHistorical) {
      console.log(
        `[RepetitionBreaker] [FORENSICS] Tool '${toolName}' identified as historical echo. Ignoring.`,
      );
      return "IGNORE";
    }

    const count = (proc.repeatTracker.get(key) || 0) + 1;
    proc.repeatTracker.set(key, count);
    
    const maxRepeats = parseInt(process.env.MAX_REPEAT_TOOL_CALLS) || 0;

    if (maxRepeats > 0 && count >= maxRepeats) {
      const errorMsg = `Loop detected: Model repeated tool '${toolName}' with same arguments ${count} times.`;
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
    
    // Check 2: Original 3+ occurrence small-block repetition
    if (accumulated.length > 600) {
      const checkLen = 200;
      const tail = accumulated.slice(-checkLen);
      
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = accumulated.indexOf(tail, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + 1;
      }

      if (count >= 3) {
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
