/**
 * Minimal stderr logger. stdout carries the MCP stdio protocol, so nothing may be written there.
 * Level is controlled by BILL_LOG_LEVEL (debug | info | warn | error | silent); default "info".
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.BILL_LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? LEVELS[raw as Level] : LEVELS.info;
}

function write(level: Exclude<Level, "silent">, message: string): void {
  if (LEVELS[level] < threshold()) return;
  process.stderr.write(`[bill-mcp] ${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
}

export const logger = {
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  warn: (m: string) => write("warn", m),
  error: (m: string) => write("error", m),
};
