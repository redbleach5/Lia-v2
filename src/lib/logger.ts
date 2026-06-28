// Структурированный логгер для всего приложения.
//
// Особенности:
//   - Уровни: trace | debug | info | warn | error
//   - Категории: chat | agent | ollama | tools | memory | db | vrm | api | rl | system
//   - Временные метки ISO 8601
//   - Контекст (taskId, episodeId, mode) — передаётся через logger.context()
//   - Управление через LOG_LEVEL env (по умолчанию info)
//   - Все логи идут в stdout/stderr — попадают в dev.log через `next dev | tee dev.log`
//
// Формат:
//   [2026-06-28T18:30:00.000Z] [INFO] [agent] task=abc123 step=2/15 | Generated plan: 5 steps
//   [2026-06-28T18:30:01.000Z] [ERROR] [ollama] | Connection refused: ECONNREFUSED 127.0.0.1:11434
//
// Usage:
//   import { logger } from '@/lib/logger';
//   logger.info('agent', 'Generated plan', { taskId, steps: 5 });
//   logger.error('ollama', 'Connection failed', e);
//
//   // С контекстом (все последующие логи включают эти поля):
//   const log = logger.context({ taskId, episodeId });
//   log.info('agent', 'Step started', { step: 2 });

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type Category = 'chat' | 'agent' | 'ollama' | 'tools' | 'memory' | 'db' | 'vrm' | 'api' | 'rl' | 'system';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m',  // gray
  debug: '\x1b[36m',  // cyan
  info: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';

const CATEGORY_COLORS: Record<Category, string> = {
  chat: '\x1b[35m',     // magenta
  agent: '\x1b[95m',    // bright magenta
  ollama: '\x1b[94m',   // bright blue
  tools: '\x1b[96m',    // bright cyan
  memory: '\x1b[93m',   // bright yellow
  db: '\x1b[33m',       // yellow
  vrm: '\x1b[92m',      // bright green
  api: '\x1b[97m',      // bright white
  rl: '\x1b[90m',       // gray
  system: '\x1b[90m',   // gray
};

// Минимальный уровень логирования из env.
// В production — info, в development — debug, можно переопределить через LOG_LEVEL.
function getMinLevel(): LogLevel {
  const fromEnv = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel;
  if (['trace', 'debug', 'info', 'warn', 'error'].includes(fromEnv)) {
    return fromEnv;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

type LogContext = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) {
    return `${value.message}${value.stack ? '\n' + value.stack : ''}`;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatContext(ctx: LogContext | undefined): string {
  if (!ctx || Object.keys(ctx).length === 0) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    const formatted = formatValue(value);
    // Короткие значения — inline, длинные — обрезаем
    const truncated = formatted.length > 200
      ? formatted.slice(0, 200) + '…'
      : formatted;
    parts.push(`${key}=${truncated}`);
  }
  return parts.join(' | ');
}

function log(
  level: LogLevel,
  category: Category,
  message: string,
  ctx?: LogContext,
  error?: unknown,
) {
  const minLevel = getMinLevel();
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const timestamp = new Date().toISOString();
  const levelTag = `${LEVEL_COLORS[level]}[${level.toUpperCase().padEnd(5)}]${RESET}`;
  const categoryTag = `${CATEGORY_COLORS[category]}[${category.padEnd(7)}]${RESET}`;
  const ctxStr = formatContext(ctx);
  const ctxPart = ctxStr ? ` ${ctxStr}` : '';

  let errorPart = '';
  if (error !== undefined) {
    const errStr = formatValue(error);
    errorPart = `\n  ↳ ${errStr}`;
  }

  const line = `[${timestamp}] ${levelTag} ${categoryTag} | ${message}${ctxPart}${errorPart}`;

  // error/warn → stderr, остальное → stdout
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// ============================================================================
// Logger API
// ============================================================================
export const logger = {
  trace: (cat: Category, msg: string, ctx?: LogContext) => log('trace', cat, msg, ctx),
  debug: (cat: Category, msg: string, ctx?: LogContext) => log('debug', cat, msg, ctx),
  info: (cat: Category, msg: string, ctx?: LogContext) => log('info', cat, msg, ctx),
  warn: (cat: Category, msg: string, ctx?: LogContext, error?: unknown) => log('warn', cat, msg, ctx, error),
  error: (cat: Category, msg: string, ctx?: LogContext, error?: unknown) => log('error', cat, msg, ctx, error),

  // Создать логгер с предустановленным контекстом.
  // Все вызовы будут автоматически включать эти поля.
  context(ctx: LogContext): ContextualLogger {
    return {
      trace: (cat: Category, msg: string, extra?: LogContext) => log('trace', cat, msg, { ...ctx, ...extra }),
      debug: (cat: Category, msg: string, extra?: LogContext) => log('debug', cat, msg, { ...ctx, ...extra }),
      info: (cat: Category, msg: string, extra?: LogContext) => log('info', cat, msg, { ...ctx, ...extra }),
      warn: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => log('warn', cat, msg, { ...ctx, ...extra }, error),
      error: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => log('error', cat, msg, { ...ctx, ...extra }, error),
    };
  },
};

export type ContextualLogger = {
  trace: (cat: Category, msg: string, extra?: LogContext) => void;
  debug: (cat: Category, msg: string, extra?: LogContext) => void;
  info: (cat: Category, msg: string, extra?: LogContext) => void;
  warn: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => void;
  error: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => void;
};

// ============================================================================
// Helper: измерение времени
// ============================================================================
export function timer(label?: string): { elapsed: () => number; log: (cat: Category, msg: string) => number } {
  const start = Date.now();
  return {
    elapsed: () => Date.now() - start,
    log: (cat: Category, msg: string) => {
      const ms = Date.now() - start;
      log('debug', cat, `${msg} (${ms}ms)`, label ? { label } : undefined);
      return ms;
    },
  };
}
