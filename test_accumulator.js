import { JsonlAccumulator } from './src/GeminiController.js';
const acc = new JsonlAccumulator();
const lines = [];
acc.on('line', l => lines.push(l));
acc.push('{"type":"tex');
acc.push('t","value":"hi"}\n{"type":"done"}\n');
if (lines.length === 2) {
    console.log('Accumulator OK');
} else {
    console.error('Failed', lines.length);
    process.exit(1);
}
