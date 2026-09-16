/**
 * Structured logging.
 *
 * Logs are JSON lines on stdout with a stable shape so a local operator can pipe
 * them into `jq` and a future deployment can ship them to any collector. Every
 * log record is redacted before it is written: secret plaintext can never be
 * logged even by accident.
 */
import { createRedactor, type Redactor } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  withSecrets(values: Iterable<string | null | undefined>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  redactor?: Redactor;
  sink?: (line: string) => void;
}

function resolveDefaultLevel(): LogLevel {
  const raw = (process.env.MENTAT_LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'warn' : 'info'))
    .toString()
    .toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const extra: LogFields = {};
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') extra.code = code;
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') extra.details = details;
    return { name: error.name, message: error.message, stack: error.stack, ...extra };
  }
  return { message: String(error) };
}

class JsonLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly base: LogFields,
    private readonly redactor: Redactor,
    private readonly sink: (line: string) => void
  ) {}

  private log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const merged: LogFields = { ...this.base, ...fields };
    if (merged.error !== undefined) merged.error = serializeError(merged.error);
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(this.redactor.value(merged) as LogFields)
    };
    this.sink(JSON.stringify(record));
  }

  debug(message: string, fields?: LogFields) {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: LogFields) {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: LogFields) {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: LogFields) {
    this.log('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(this.level, { ...this.base, ...fields }, this.redactor, this.sink);
  }

  withSecrets(values: Iterable<string | null | undefined>): Logger {
    for (const value of values) this.redactor.register(value);
    return this;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  return new JsonLogger(
    options.level ?? resolveDefaultLevel(),
    options.base ?? {},
    options.redactor ?? createRedactor(),
    sink
  );
}

/** Process-wide logger. Prefer contextual children over ad-hoc instances. */
export const rootLogger = createLogger();

export function moduleLogger(module: string, fields: LogFields = {}): Logger {
  return rootLogger.child({ module, ...fields });
}
