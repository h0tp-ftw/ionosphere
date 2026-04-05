import { performance } from "perf_hooks";
import fs from "fs";
import path from "path";

const ENABLED = process.env.GEMINI_PERF_TIMING === "true";
const PERF_LOG_PATH = process.env.GEMINI_PERF_LOG || null;

/**
 * Lightweight per-request performance timer.
 *
 * Usage:
 *   const timer = new PerfTimer(turnId, { messages: 47, promptChars: 125000 });
 *   timer.mark('ingress');
 *   ... work ...
 *   timer.measure('ingress');
 *   timer.mark('session_resolve');
 *   ... work ...
 *   timer.measure('session_resolve');
 *   timer.finish();  // writes summary to file
 *
 * When GEMINI_PERF_TIMING !== "true", all methods are no-ops (zero overhead).
 */
export class PerfTimer {
  /**
   * @param {string} turnId - Unique ID for this turn/request.
   * @param {object} meta  - Contextual metadata (message count, prompt size, etc.)
   * @param {string} [outputDir] - Directory to write the perf log into (per-turn temp dir).
   */
  constructor(turnId, meta = {}, outputDir = null) {
    this.enabled = ENABLED;
    if (!this.enabled) return;

    this.turnId = turnId;
    this.meta = meta;
    this.outputDir = outputDir;
    this.marks = new Map();    // phase -> start timestamp (ms)
    this.durations = new Map(); // phase -> duration (ms)
    this.subPhases = new Map(); // phase -> { subName: durationMs }
    this.requestStart = performance.now();
  }

  /**
   * Mark the START of a phase.
   */
  mark(phase) {
    if (!this.enabled) return;
    this.marks.set(phase, performance.now());
  }

  /**
   * Mark the END of a phase (computes duration from the last mark).
   * @param {string} phase
   * @param {object} [subPhases] - Optional sub-phase durations: { hash: 5, fingerprint: 1 }
   */
  measure(phase, subPhases = null) {
    if (!this.enabled) return;
    const start = this.marks.get(phase);
    if (start === undefined) {
      console.warn(`[PerfTimer] measure('${phase}') called without mark.`);
      return;
    }
    const duration = performance.now() - start;
    this.durations.set(phase, duration);
    if (subPhases) {
      this.subPhases.set(phase, subPhases);
    }
    this.marks.delete(phase);
  }

  /**
   * Add metadata after construction (e.g., prompt size only known later).
   */
  addMeta(key, value) {
    if (!this.enabled) return;
    this.meta[key] = value;
  }

  /**
   * Record a duration directly (for cases where start/end are in different modules).
   */
  record(phase, durationMs, subPhases = null) {
    if (!this.enabled) return;
    this.durations.set(phase, durationMs);
    if (subPhases) {
      this.subPhases.set(phase, subPhases);
    }
  }

  /**
   * Generates the summary object.
   */
  _buildSummary() {
    const totalMs = performance.now() - this.requestStart;
    const phases = {};
    for (const [phase, dur] of this.durations) {
      const entry = { ms: Math.round(dur * 100) / 100 };
      const subs = this.subPhases.get(phase);
      if (subs) {
        entry.sub = {};
        for (const [k, v] of Object.entries(subs)) {
          entry.sub[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
        }
      }
      phases[phase] = entry;
    }

    return {
      turnId: this.turnId,
      timestamp: new Date().toISOString(),
      meta: this.meta,
      totalMs: Math.round(totalMs * 100) / 100,
      phases,
    };
  }

  /**
   * Format the summary as a human-readable string.
   */
  _formatSummary(summary) {
    const lines = [];
    lines.push(`[PERF] Turn ${summary.turnId} Summary:`);

    // Meta line
    const metaParts = Object.entries(summary.meta)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (metaParts) lines.push(`  ${metaParts}`);

    // Phase lines
    const phaseLabels = {
      ingress: "① ingress",
      session_resolve: "② session_resolve",
      handoff: "③a handoff",
      new_turn_setup: "③b new_turn_setup",
      ipc_setup: "④ ipc_setup",
      config_gen: "⑤ config_gen",
      cli_execution: "⑥⑦ cli_execution",
      response: "⑧ response",
      cleanup: "⑨ cleanup",
    };

    for (const [phase, data] of Object.entries(summary.phases)) {
      const label = phaseLabels[phase] || phase;
      let line = `  ${label.padEnd(25)} ${String(data.ms).padStart(8)}ms`;
      if (data.sub) {
        const subParts = Object.entries(data.sub)
          .map(([k, v]) => `${k}: ${v}${typeof v === 'number' ? 'ms' : ''}`)
          .join(", ");
        line += `  (${subParts})`;
      }
      lines.push(line);
    }

    lines.push(`  ${"TOTAL".padEnd(25)} ${String(summary.totalMs).padStart(8)}ms`);
    return lines.join("\n");
  }

  /**
   * Finalize and write the perf summary.
   * Writes to:
   *   1. Per-turn temp dir as `perf_timing.json` (if outputDir set)
   *   2. Consolidated log file at GEMINI_PERF_LOG path (if set), appended as JSONL
   *   3. Console (abbreviated)
   */
  finish() {
    if (!this.enabled) return;

    const summary = this._buildSummary();
    const humanReadable = this._formatSummary(summary);
    const jsonLine = JSON.stringify(summary);

    // Console: short version
    console.log(humanReadable);

    // Per-turn file
    if (this.outputDir) {
      try {
        if (!fs.existsSync(this.outputDir)) {
          fs.mkdirSync(this.outputDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(this.outputDir, "perf_timing.json"),
          JSON.stringify(summary, null, 2),
          "utf-8"
        );
      } catch (e) {
        console.error(`[PerfTimer] Failed to write per-turn perf file: ${e.message}`);
      }
    }

    // Consolidated JSONL log (append)
    const logPath = PERF_LOG_PATH || path.join(process.cwd(), "perf_timing.jsonl");
    try {
      fs.appendFileSync(logPath, jsonLine + "\n", "utf-8");
    } catch (e) {
      console.error(`[PerfTimer] Failed to append to consolidated log: ${e.message}`);
    }

    return summary;
  }
}

/**
 * Quick helper to time a synchronous function and return { result, durationMs }.
 */
export function timeSync(fn) {
  if (!ENABLED) return { result: fn(), durationMs: 0 };
  const start = performance.now();
  const result = fn();
  return { result, durationMs: performance.now() - start };
}

/**
 * Quick helper to time an async function and return { result, durationMs }.
 */
export async function timeAsync(fn) {
  if (!ENABLED) return { result: await fn(), durationMs: 0 };
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}
