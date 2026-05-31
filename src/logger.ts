// Structured JSON logger. One-line-per-event so a redirect can be grep'd.
// No third-party logger; the constitution forbids unnecessary dependencies
// at MVP scale. Production paths NEVER use console.log directly (ESLint
// no-console warns); this is the documented exception.

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
];

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_PATTERNS) out = out.replace(re, '<REDACTED>');
    return out;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) out[k] = redact(obj[k]);
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly event: string;
  readonly [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    ...redact(fields) as Record<string, unknown>,
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    // eslint-disable-next-line no-console -- logger sink, documented exception
    console.log(line);
  }
}

export const log = {
  debug: (fields: LogFields): void => { emit('debug', fields); },
  info:  (fields: LogFields): void => { emit('info',  fields); },
  warn:  (fields: LogFields): void => { emit('warn',  fields); },
  error: (fields: LogFields): void => { emit('error', fields); },
};
