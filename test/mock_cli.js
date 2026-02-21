const fs = require('fs');

// We simply simulate the backend CLI emitting an NDJSON tool call immediately
process.stdout.write(JSON.stringify({
    type: 'toolCall',
    toolCallId: 'call_abc123',
    functionCall: {
        name: 'echo',
        args: {
            text: 'backend simulated argument text'
        }
    }
}) + '\n');

// Then simulate clean exit
process.stdout.write(JSON.stringify({
    type: 'done',
    code: 0
}) + '\n');
