import fs from "fs";
import path from "path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_EXTRACT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const newestMtimeInDir = (dirPath) => {
  let newest = 0;
  try {
    for (const child of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const childPath = path.join(dirPath, child.name);
      try {
        const s = fs.statSync(childPath);
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      } catch (_) {}
    }
  } catch (_) {}
  return newest;
};

const sweepDirectory = (dirPath, now, gcTtlMs, isTurnActive) => {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    let stats;
    try { stats = fs.statSync(entryPath); } catch (_) { continue; }

    const turnIdMatch = entry.name.match(UUID_EXTRACT_RE);
    const associatedTurnId = turnIdMatch ? turnIdMatch[0] : entry.name;
    if (isTurnActive(associatedTurnId)) continue;

    if (entry.isDirectory() && UUID_RE.test(entry.name)) {
      const lastActivity = Math.max(stats.mtimeMs, newestMtimeInDir(entryPath));
      if (now - lastActivity <= gcTtlMs) continue;
      console.log(`[GC] Sweeping abandoned workspace: ${entryPath}`);
      fs.rmSync(entryPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      sweepDirectory(entryPath, now, gcTtlMs, isTurnActive);
      try {
        const remaining = fs.readdirSync(entryPath);
        if (remaining.length === 0) {
          console.log(`[GC] Removing empty directory: ${entryPath}`);
          fs.rmdirSync(entryPath);
        }
      } catch (_) {}
    } else if (entry.isFile() && now - stats.mtimeMs > gcTtlMs) {
      const isHistoryFile = entry.name.startsWith("turn-") && entry.name.endsWith("-history.json");
      const isDebugFile = entry.name.endsWith(".txt") || entry.name.endsWith(".json");
      if (isHistoryFile || isDebugFile) {
        console.log(`[GC] Sweeping orphaned temp file: ${entry.name}`);
        fs.unlinkSync(entryPath);
      }
    }
  }
};

/**
 * Starts the periodic GC sweeper for abandoned workspaces.
 * @param {string} baseTempDir - The temp directory to sweep.
 * @param {function} isTurnActive - (turnId) => boolean, checks parkedTurns/processes.
 * @returns {NodeJS.Timeout} The interval handle (for cleanup on shutdown).
 */
const startGcSweeper = (baseTempDir, isTurnActive) => {
  return setInterval(
    () => {
      try {
        const now = Date.now();
        const gcTtlMs = parseInt(process.env.GC_WORKSPACE_TTL_MS) || 30 * 60 * 1000;
        sweepDirectory(baseTempDir, now, gcTtlMs, isTurnActive);
      } catch (e) {
        console.error(`[GC] Sweeper error:`, e);
      }
    },
    5 * 60 * 1000,
  );
};

export { startGcSweeper };
