import { createError, ErrorType, ErrorCode } from "./errorHandler.js";

/**
 * Parses stderr output from the Gemini CLI to identify specific error types.
 */
export class CliErrorParser {
  /**
   * Identifies if an error is fatal and should terminate the process.
   */
  parseStderr(stderrText, activeCallbacks) {
    if (!stderrText) return null;

    const isAuthError =
      (/(please log in|\bauthorization\b|authenticate|not authenticated)/i.test(
        stderrText,
      ) &&
        !/unauthorized tool call/i.test(stderrText)) ||
      (/credentials/i.test(stderrText) &&
        !/loaded cached credentials/i.test(stderrText));

    const isResourceError =
      /RESOURCE_EXHAUSTED|rateLimitExceeded|429|No capacity available|exhausted your capacity|TerminalQuotaError|quota will reset|MODEL_CAPACITY_EXHAUSTED/i.test(
        stderrText,
      );

    const isPolicyError =
      /denied by policy|unauthorized tool call|not available to this agent/i.test(
        stderrText,
      );

    const isContextError =
      /too large|too long|context window|token limit|maximum tokens|request is too large/i.test(
        stderrText,
      );

    const isSafetyError =
      /safety settings|blocked|moderate|content filter|candidate was blocked/i.test(
        stderrText,
      );

    const isNotFound = /Tool "([^"]+)" not found/i.test(stderrText);

    const isModelError =
      /ModelNotFoundError|entity was not found/i.test(stderrText);

    if (isAuthError) {
      const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.AUTHENTICATION, ErrorCode.INVALID_API_KEY),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isResourceError) {
      const errorMsg = `Gemini API Quota/Capacity Exhausted (429). Raw: ${stderrText}`;
      console.log(`[DEBUG] CliErrorParser: Matched isResourceError! Error message: ${errorMsg}`);
      // [IONOSPHERE] Proactive Termination: Even with SILENT_FALLBACK, we return FATAL 
      // so the GeminiController kills the stuck CLI process immediately. This allows 
      // the orchestrator (index.js) to trigger fallback/retry logic without waiting 
      // for the CLI's internal retry timeouts.
      if (activeCallbacks.onError && process.env.GEMINI_SILENT_FALLBACK !== "true")
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.RATE_LIMIT, ErrorCode.RATE_LIMIT_EXCEEDED),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isContextError) {
      const errorMsg = `Gemini API Context Window Exceeded. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.CONTEXT_LENGTH_EXCEEDED),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isSafetyError) {
      const errorMsg = `Gemini API Content Filter / Safety Block. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.CONTENT_FILTER),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isModelError) {
      const errorMsg = `Fatal: Model not found or inaccessible. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.MODEL_NOT_FOUND),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isPolicyError) {
      const errorMsg = `Fatal: Tool use or action denied by policy. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.PERMISSION, ErrorCode.POLICY_DENIED),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isNotFound) {
      const match = stderrText.match(/Tool "([^"]+)" not found/i);
      const toolName = match ? match[1] : "unknown";
      const errorMsg = `Fatal: Tool "${toolName}" not found. This environment does not support ${toolName}.`;
      
      if (activeCallbacks.onEvent) {
        activeCallbacks.onEvent({
          type: "tool_result",
          tool_name: toolName,
          result: errorMsg,
          is_error: true,
        });
      }
      return { type: "SOFT", message: errorMsg, toolName };
    }

    return null;
  }
}
