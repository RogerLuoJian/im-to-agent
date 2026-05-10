export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function serialize(data: unknown): string {
  if (data instanceof Error) {
    return JSON.stringify({ name: data.name, message: data.message, stack: data.stack });
  }
  return JSON.stringify(data);
}

function format(level: LogLevel, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  return data !== undefined ? `${base} ${serialize(data)}` : base;
}

export const log = {
  debug: (msg: string, data?: unknown) => { if (shouldLog('debug')) console.debug(format('debug', msg, data)); },
  info:  (msg: string, data?: unknown) => { if (shouldLog('info'))  console.info(format('info', msg, data)); },
  warn:  (msg: string, data?: unknown) => { if (shouldLog('warn'))  console.warn(format('warn', msg, data)); },
  error: (msg: string, data?: unknown) => { if (shouldLog('error')) console.error(format('error', msg, data)); },
};
