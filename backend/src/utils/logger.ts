/**
 * Minimal logger wrapper. Swap for pino/winston later if needed.
 * Using a thin wrapper now so the rest of the codebase doesn't
 * have to change when we upgrade.
 */
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Fields the log line owns. A caller's `meta` may not overwrite them — see
 * `buildEntry`.
 */
const RESERVED_FIELDS = ['ts', 'level', 'message'] as const;

/**
 * Levels that go to stderr rather than stdout.
 *
 * `warn` is here deliberately. The hotel price guards warn when a provider row
 * is dropped, and they exist precisely so a bad feed is visible — on stdout
 * they are invisible to anyone reading only the error stream.
 *
 * The usual argument for putting everything on stdout is that a structured
 * collector wants one clean JSON stream. That does not apply here: stdout
 * already carries morgan's `combined` access lines (plain text, not JSON)
 * alongside these entries, so it is a mixed stream either way and nothing can
 * be parsing it as pure JSON.
 *
 * `level` stays in the payload and remains the precise filter — the stream
 * split is a coarse convenience on top of it, not a replacement. If this ever
 * needs reverting it is this one set.
 */
const STDERR_LEVELS = new Set<LogLevel>(['warn', 'error']);

/**
 * Merge `meta` into the entry without letting it clobber the reserved fields.
 *
 * Callers pass `{ message: err.message }` in 20-odd places. Spreading that
 * over the entry used to REPLACE the log's own message, so
 * `logger.warn('Hotel search failed (non-fatal)', { message: err.message })`
 * emitted only the error text and the label never reached the log at all —
 * you could not grep for it. Reserved fields now win, and the caller's value
 * is kept under a `meta_` prefix so nothing is silently dropped either.
 */
function buildEntry(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  };

  for (const [key, value] of Object.entries(meta ?? {})) {
    const safeKey = (RESERVED_FIELDS as readonly string[]).includes(key) ? `meta_${key}` : key;
    entry[safeKey] = value;
  }

  return entry;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify(buildEntry(level, message, meta));
  if (STDERR_LEVELS.has(level)) console.error(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
};
