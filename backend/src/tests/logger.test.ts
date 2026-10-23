import { logger } from '../utils/logger';

/**
 * Two things this logger has to get right, both operational rather than
 * cosmetic.
 *
 * 1. WHICH STREAM. The hotel price guards warn when a provider row is dropped,
 *    and they exist precisely so a bad feed is visible. On stdout they are
 *    invisible to anyone reading only the error stream.
 *
 * 2. WHOSE `message` WINS. ~20 call sites pass `{ message: err.message }` as
 *    meta. Spreading that over the entry used to REPLACE the log's own
 *    message, so `logger.warn('Hotel search failed (non-fatal)', { message })`
 *    emitted only the error text — the label never reached the log and could
 *    not be grepped for.
 */

type Captured = { stream: 'stdout' | 'stderr'; entry: Record<string, unknown> };

let captured: Captured[];
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

beforeEach(() => {
  captured = [];
  logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    captured.push({ stream: 'stdout', entry: JSON.parse(String(line)) });
  });
  errSpy = jest.spyOn(console, 'error').mockImplementation((line?: unknown) => {
    captured.push({ stream: 'stderr', entry: JSON.parse(String(line)) });
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const only = () => {
  expect(captured).toHaveLength(1);
  return captured[0];
};

describe('log level routing', () => {
  it('sends warn to stderr, so a stderr-only filter still shows dropped-hotel warnings', () => {
    logger.warn('Hotel dropped — price far above the median for this search', {
      city: 'Florence',
      pricePerNight: 5383.47,
    });

    const { stream, entry } = only();
    expect(stream).toBe('stderr');
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('Hotel dropped — price far above the median for this search');
  });

  it('sends error to stderr', () => {
    logger.error('boom');
    expect(only().stream).toBe('stderr');
  });

  it('keeps info and debug on stdout — they are not problem reports', () => {
    logger.info('started');
    logger.debug('details');

    expect(captured.map((c) => c.stream)).toEqual(['stdout', 'stdout']);
  });

  it('still carries `level` in the payload, which stays the precise filter', () => {
    logger.warn('w');
    logger.error('e');
    logger.info('i');
    logger.debug('d');

    expect(captured.map((c) => c.entry.level)).toEqual(['warn', 'error', 'info', 'debug']);
  });
});

describe('reserved fields', () => {
  it("does not let meta.message overwrite the log's own message", () => {
    logger.warn('Hotel search failed (non-fatal)', {
      message: 'getaddrinfo ENOTFOUND db.supabase.co',
      city: 'Florence',
    });

    const { entry } = only();
    expect(entry.message).toBe('Hotel search failed (non-fatal)');
    expect(entry.city).toBe('Florence');
  });

  it("keeps the caller's colliding value rather than dropping it", () => {
    logger.warn('label', { message: 'the underlying error' });

    expect(only().entry.meta_message).toBe('the underlying error');
  });

  it('protects ts and level too', () => {
    logger.warn('label', { ts: 'not-a-timestamp', level: 'info' });

    const { entry } = only();
    expect(entry.level).toBe('warn');
    expect(entry.ts).not.toBe('not-a-timestamp');
    expect(entry.meta_ts).toBe('not-a-timestamp');
    expect(entry.meta_level).toBe('info');
  });

  it('passes ordinary meta through untouched', () => {
    logger.warn('Hotel dropped — price implausible for its star rating', {
      city: 'Florence',
      hotel: 'Hotel Aldobrandini',
      stars: 3,
      pricePerNight: 5383.47,
      ceiling: 1000,
    });

    expect(only().entry).toMatchObject({
      city: 'Florence',
      hotel: 'Hotel Aldobrandini',
      stars: 3,
      pricePerNight: 5383.47,
      ceiling: 1000,
    });
  });

  it('emits one line of valid JSON with a timestamp, with or without meta', () => {
    logger.info('no meta here');

    const { entry } = only();
    expect(typeof entry.ts).toBe('string');
    expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false);
    expect(entry.message).toBe('no meta here');
  });
});
