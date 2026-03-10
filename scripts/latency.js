#!/usr/bin/env node
/**
 * latency.js — Ionosphere Latency Benchmark
 *
 * Measures:
 *   • Time-to-First-Byte (TTFB) — first SSE data chunk from the server
 *   • Time-to-First-Token (TTFT) — first chunk with actual content
 *   • Total round-trip time for a 1-token generation
 *
 * Usage:
 *   node scripts/latency.js                         # single run
 *   node scripts/latency.js --runs 5                # average over 5 runs
 *   node scripts/latency.js --url http://host:3000  # custom base URL
 *   node scripts/latency.js --key YOUR_API_KEY      # override API key
 */

import http from "http";
import https from "https";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
};

// Try to load API_KEY from .env if not in environment
let envApiKey = process.env.API_KEY || "";
if (!envApiKey) {
  try {
    const envFile = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
    const match = envFile.match(/^API_KEY=(.+)$/m);
    if (match) envApiKey = match[1].trim();
  } catch { /* no .env file */ }
}

const BASE_URL = flag("--url") || process.env.IONOSPHERE_URL || "http://localhost:3000";
const RUNS     = parseInt(flag("--runs") || "1", 10);
const API_KEY  = flag("--key") || envApiKey;

// ── Core request ─────────────────────────────────────────────────────────────
function measureLatency() {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/chat/completions", BASE_URL);
    const transport = url.protocol === "https:" ? https : http;

    const payload = JSON.stringify({
      model: "gemini",
      stream: true,
      max_tokens: 1,
      messages: [
        { role: "user", content: "Say the single letter A" }
      ],
    });

    const reqStart = performance.now();
    let firstByteTime = null;   // any data chunk from the server
    let firstTokenTime = null;  // first chunk with actual content
    let tokenContent = "";
    let chunkCount = 0;

    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
    };

    const req = transport.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
        return;
      }

      let sseBuffer = "";

      res.on("data", (chunk) => {
        chunkCount++;
        const now = performance.now();

        if (firstByteTime === null) {
          firstByteTime = now;
        }

        sseBuffer += chunk.toString();

        // Parse SSE events
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);

            // Streaming response: delta.content
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              if (firstTokenTime === null) firstTokenTime = now;
              tokenContent += delta.content;
            }

            // Non-streaming response embedded in stream (some proxies do this)
            const message = parsed.choices?.[0]?.message;
            if (message?.content) {
              if (firstTokenTime === null) firstTokenTime = now;
              tokenContent += message.content;
            }
          } catch {
            // ignore malformed SSE
          }
        }
      });

      res.on("end", () => {
        // Parse any remaining buffer
        if (sseBuffer.trim()) {
          const remaining = sseBuffer.trim();
          if (remaining.startsWith("data: ") && remaining.slice(6).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(remaining.slice(6).trim());
              const delta = parsed.choices?.[0]?.delta;
              const message = parsed.choices?.[0]?.message;
              if (delta?.content) tokenContent += delta.content;
              if (message?.content) tokenContent += message.content;
            } catch { /* ignore */ }
          }
        }

        const endTime = performance.now();
        resolve({
          ttfb: firstByteTime !== null ? firstByteTime - reqStart : null,
          ttft: firstTokenTime !== null ? firstTokenTime - reqStart : null,
          total: endTime - reqStart,
          token: tokenContent.trim(),
          chunks: chunkCount,
        });
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmt = (ms) => {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         Ionosphere Latency Benchmark            ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Target:     ${BASE_URL}`);
  console.log(`  Runs:       ${RUNS}`);
  console.log(`  Max Tokens: 1`);
  console.log(`  Prompt:     "Say the single letter A"`);
  console.log();

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    const label = RUNS > 1 ? `  Run ${i + 1}/${RUNS}` : "  Result";
    process.stdout.write(`${label}: measuring...`);

    try {
      const r = await measureLatency();
      results.push(r);

      // Overwrite the "measuring..." text
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);

      const tokenDisplay = r.token ? `"${r.token.substring(0, 20)}"` : "(buffered)";
      console.log(
        `${label}: TTFB=${fmt(r.ttfb)}  TTFT=${fmt(r.ttft)}  Total=${fmt(r.total)}  Output=${tokenDisplay}`
      );
    } catch (err) {
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      console.log(`${label}: ERROR — ${err.message}`);
    }

    // Small cooldown between runs
    if (i < RUNS - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  if (results.length > 0) {
    console.log();
    console.log("──────────────────────────────────────────────────");

    const ttfbs = results.filter((r) => r.ttfb !== null).map((r) => r.ttfb);
    const ttfts = results.filter((r) => r.ttft !== null).map((r) => r.ttft);
    const totals = results.map((r) => r.total);

    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = (arr) => Math.min(...arr);
    const max = (arr) => Math.max(...arr);
    const p50 = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };

    const statLine = (label, arr) =>
      `  ${label.padEnd(6)}— avg: ${fmt(avg(arr))}  min: ${fmt(min(arr))}  max: ${fmt(max(arr))}  p50: ${fmt(p50(arr))}`;

    if (ttfbs.length > 0) console.log(statLine("TTFB", ttfbs));
    if (ttfts.length > 0) console.log(statLine("TTFT", ttfts));
    console.log(statLine("Total", totals));

    if (ttfts.length === 0 && ttfbs.length > 0) {
      console.log();
      console.log("  Note: TTFT=n/a because the proxy buffers short responses.");
      console.log("        TTFB measures when the server first responded.");
      console.log("        Total is the definitive end-to-end latency.");
    }
    console.log("──────────────────────────────────────────────────");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
