const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

const configured = (process.env.LOG_LEVEL || "info").toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

const logger = {
  debug: (...args) => { if (threshold <= LEVELS.debug) console.log(...args); },
  info:  (...args) => { if (threshold <= LEVELS.info)  console.log(...args); },
  warn:  (...args) => { if (threshold <= LEVELS.warn)  console.warn(...args); },
  error: (...args) => { if (threshold <= LEVELS.error) console.error(...args); },
};

export { logger, LEVELS };
