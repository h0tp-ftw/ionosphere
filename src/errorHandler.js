export const ErrorType = {
    INVALID_REQUEST: 'invalid_request_error',
    AUTHENTICATION: 'authentication_error',
    PERMISSION: 'permission_error',
    RATE_LIMIT: 'rate_limit_error',
    SERVER: 'server_error',
    API: 'api_error'
};

export const ErrorCode = {
    INVALID_API_KEY: 'invalid_api_key',
    MODEL_NOT_FOUND: 'model_not_found',
    RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
    CONTEXT_LENGTH_EXCEEDED: 'context_length_exceeded',
    INTERNAL_ERROR: 'internal_error',
    POLICY_DENIED: 'policy_denied',
    CLI_FAILURE: 'cli_failure',
    CONTENT_FILTER: 'content_filter',
    UPSTREAM_TIMEOUT: 'upstream_timeout'
};

/**
 * Creates a standardized error object.
 * @param {string} message - The error message.
 * @param {string} type - The error type (e.g., 'invalid_request_error').
 * @param {string} code - The error code (e.g., 'model_not_found').
 * @param {string|null} param - The parameter that caused the error.
 * @returns {object} The error object.
 */
export function createError(message, type = ErrorType.SERVER, code = ErrorCode.INTERNAL_ERROR, param = null) {
    return {
        message,
        type,
        code,
        param
    };
}

/**
 * Determines the HTTP status code based on the error object.
 * @param {object} error - The error object.
 * @returns {number} The HTTP status code.
 */
export function getStatusCode(error) {
    if (!error) return 500;

    // Check code first
    switch (error.code) {
        case ErrorCode.INVALID_API_KEY: return 401;
        case ErrorCode.RATE_LIMIT_EXCEEDED: return 429;
        case ErrorCode.MODEL_NOT_FOUND: return 404;
        case ErrorCode.POLICY_DENIED: return 403;
        case ErrorCode.CONTEXT_LENGTH_EXCEEDED: return 400;
        case ErrorCode.CONTENT_FILTER: return 400;
        case ErrorCode.UPSTREAM_TIMEOUT: return 504;
    }

    // Fallback to type
    switch (error.type) {
        case ErrorType.INVALID_REQUEST: return 400;
        case ErrorType.AUTHENTICATION: return 401;
        case ErrorType.PERMISSION: return 403;
        case ErrorType.RATE_LIMIT: return 429;
        case ErrorType.SERVER: return 500;
        default: return 500;
    }
}

/**
 * Detects the specific error type and code from various Gemini/CLI error shapes.
 * This helper centralizes heuristic detection logic.
 */
function detectErrorContext(err) {
    let message = err.message || (typeof err === 'string' ? err : "Unknown error");
    let type = err.type || ErrorType.SERVER;
    let code = err.code || ErrorCode.INTERNAL_ERROR;

    // Direct Status Mapping from common library patterns
    const status = err.status || (err.cause && err.cause.code);

    // 1. Quota / Rate Limit (429)
    if (
        status === 429 ||
        err.reason === 'QUOTA_EXHAUSTED' || 
        err.reason === 'MODEL_CAPACITY_EXHAUSTED' ||
        /quota|exhausted|capacity|429/i.test(message)
    ) {
        return { type: ErrorType.RATE_LIMIT, code: ErrorCode.RATE_LIMIT_EXCEEDED };
    }

    // 2. Auth / Permissions (401/403)
    if (status === 401 || /unauthenticated|invalid api key|invalid_api_key/i.test(message)) {
        return { type: ErrorType.AUTHENTICATION, code: ErrorCode.INVALID_API_KEY };
    }
    if (status === 403 || /permission_denied|permission denied/i.test(message)) {
        return { type: ErrorType.PERMISSION, code: ErrorCode.POLICY_DENIED };
    }

    // 3. Not Found (404)
    if (status === 404 || /not_found|not found/i.test(message)) {
        return { type: ErrorType.INVALID_REQUEST, code: ErrorCode.MODEL_NOT_FOUND };
    }

    // 4. Context Window / Request Size (400/504/500)
    // Heuristic: Gemini often returns 500 or 504 for large context before it hits the model.
    if (
        /too large|too long|context window|token limit|maximum|context_length_exceeded/i.test(message) ||
        (status === 504 && /deadline|timeout/i.test(message))
    ) {
        return { type: ErrorType.INVALID_REQUEST, code: ErrorCode.CONTEXT_LENGTH_EXCEEDED };
    }

    // 5. Safety Filters
    if (/safety|blocked|moderate|filter/i.test(message)) {
        return { type: ErrorType.INVALID_REQUEST, code: ErrorCode.CONTENT_FILTER };
    }

    // 6. Failed Precondition (Often maps to quota, billing or region issues in Gemini)
    if (/failed_precondition/i.test(message)) {
        if (/billing|tier|region|quota/i.test(message)) {
            return { type: ErrorType.RATE_LIMIT, code: ErrorCode.RATE_LIMIT_EXCEEDED };
        }
    }

    return { type, code };
}

/**
 * Formats an error response for the API.
 * Ensures strict OpenAI compatibility: { error: { message, type, param, code } }
 * @param {object|string} err - The error object or message.
 * @param {string} defaultType - Default error type if not present.
 * @param {string} defaultCode - Default error code if not present.
 * @returns {object} The formatted error object (inner 'error' object).
 */
export function formatErrorResponse(err, defaultType = ErrorType.SERVER, defaultCode = ErrorCode.INTERNAL_ERROR) {
    if (typeof err === 'string') {
        const detected = detectErrorContext(err);
        return createError(err, detected.type, detected.code);
    }

    // Detect specialized context
    const detected = detectErrorContext(err);
    
    return createError(
        err.message || "Unknown error",
        err.type || detected.type || defaultType,
        err.code || detected.code || defaultCode,
        err.param || null
    );
}
/**
 * Custom error used to signal the orchestrator to perform an internal retry.
 */
export class RetryableError extends Error {
  constructor(message, reason, attempt = 0, isRepetitionKill = false, isStall = false, isQuota = false) {
    super(message);
    this.name = "RetryableError";
    this.reason = reason;
    this.attempt = attempt;
    this.isRepetitionKill = isRepetitionKill;
    this.isStall = isStall;
    this.isQuota = isQuota;
  }
}
