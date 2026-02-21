import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

let cliPath = process.env.GEMINI_CLI_PATH || 'gemini';
if (process.platform === 'win32' && !cliPath.endsWith('.cmd') && !cliPath.endsWith('.exe')) {
    cliPath += '.cmd';
}

const args = ['-y', '-o', 'stream-json', '-p', 'hello'];

const cliProcess = spawn(cliPath, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
});

cliProcess.stdout.on('data', d => console.log('STDOUT:', d.toString()));
cliProcess.stderr.on('data', d => console.log('STDERR:', d.toString()));
cliProcess.on('close', c => console.log('EXIT:', c));
