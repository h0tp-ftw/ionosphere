import test from 'node:test';
import assert from 'node:assert';
import {
    createError,
    formatErrorResponse,
    getStatusCode,
    ErrorType,
    ErrorCode
} from '../src/errorHandler.js';

test('createError - returns correct object structure', (t) => {
    const err = createError('Test message', ErrorType.INVALID_REQUEST, ErrorCode.MODEL_NOT_FOUND, 'model');
    assert.deepStrictEqual(err, {
        message: 'Test message',
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.MODEL_NOT_FOUND,
        param: 'model'
    });
});

test('getStatusCode - returns correct status for known codes', (t) => {
    assert.strictEqual(getStatusCode({ code: ErrorCode.INVALID_API_KEY }), 401);
    assert.strictEqual(getStatusCode({ code: ErrorCode.RATE_LIMIT_EXCEEDED }), 429);
    assert.strictEqual(getStatusCode({ code: ErrorCode.MODEL_NOT_FOUND }), 404);
    assert.strictEqual(getStatusCode({ code: ErrorCode.POLICY_DENIED }), 403);
    assert.strictEqual(getStatusCode({ code: ErrorCode.CONTEXT_LENGTH_EXCEEDED }), 400);
});

test('getStatusCode - falls back to type if code is unknown', (t) => {
    assert.strictEqual(getStatusCode({ type: ErrorType.INVALID_REQUEST }), 400);
    assert.strictEqual(getStatusCode({ type: ErrorType.AUTHENTICATION }), 401);
    assert.strictEqual(getStatusCode({ type: ErrorType.PERMISSION }), 403);
    assert.strictEqual(getStatusCode({ type: ErrorType.RATE_LIMIT }), 429);
    assert.strictEqual(getStatusCode({ type: ErrorType.SERVER }), 500);
});

test('getStatusCode - returns 500 for unknown errors', (t) => {
    assert.strictEqual(getStatusCode({}), 500);
    assert.strictEqual(getStatusCode(null), 500);
});

test('formatErrorResponse - formats string errors', (t) => {
    const err = formatErrorResponse('Something went wrong');
    assert.strictEqual(err.message, 'Something went wrong');
    assert.strictEqual(err.type, ErrorType.SERVER);
    assert.strictEqual(err.code, ErrorCode.INTERNAL_ERROR);
    assert.strictEqual(err.param, null);
});

test('formatErrorResponse - formats error objects', (t) => {
    const input = { message: 'Bad request', type: 'custom_type', code: 'custom_code' };
    const err = formatErrorResponse(input);
    assert.strictEqual(err.message, 'Bad request');
    assert.strictEqual(err.type, 'custom_type');
    assert.strictEqual(err.code, 'custom_code');
    assert.strictEqual(err.param, null);
});

test('formatErrorResponse - preserves existing params', (t) => {
    const input = { message: 'Invalid model', param: 'model' };
    const err = formatErrorResponse(input, ErrorType.INVALID_REQUEST, ErrorCode.MODEL_NOT_FOUND);
    assert.strictEqual(err.message, 'Invalid model');
    assert.strictEqual(err.type, ErrorType.INVALID_REQUEST);
    assert.strictEqual(err.code, ErrorCode.MODEL_NOT_FOUND);
    assert.strictEqual(err.param, 'model');
});
