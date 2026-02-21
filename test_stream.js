import fs from 'fs';
import http from 'http';

const payload = fs.readFileSync('payload.json');

const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/prompt',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    res.on('data', (chunk) => {
        console.log(chunk.toString());
    });
    res.on('end', () => {
        console.log('No more data in response.');
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(payload);
req.end();
