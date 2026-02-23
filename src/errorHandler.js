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
    INVALID_PARAMETER: 'invalid_parameter'
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
 * Formats an error response for the API.
 * Ensures strict OpenAI compatibility: { error: { message, type, param, code } }
 * @param {object|string} err - The error object or message.
 * @param {string} defaultType - Default error type if not present.
 * @param {string} defaultCode - Default error code if not present.
 * @returns {object} The formatted error object (inner 'error' object).
 */
export function formatErrorResponse(err, defaultType = ErrorType.SERVER, defaultCode = ErrorCode.INTERNAL_ERROR) {
    if (typeof err === 'string') {
        return createError(err, defaultType, defaultCode);
    }

    const message = err.message || "Unknown error";
    const type = err.type || defaultType;
    const code = err.code || defaultCode;
    const param = err.param || null;

    return {
        message,
        type,
        param,
        code
    };
}
