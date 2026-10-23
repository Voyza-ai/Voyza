import { addDays, clampToFuture, todayIso } from '../utils/dates';

// Every assertion here must hold under any TZ — run with
//   TZ=UTC / TZ=America/New_York / TZ=Asia/Kolkata npx jest src/tests/dates.test.ts
// The old optimizer/constraints copies failed the first two describe blocks
// under TZ=America/New_York.

describe('addDays', () => {
  it('crosses the US spring-forward boundary without losing a day', () => {
    // Old local-mutation version returned 2026-03-14 under America/New_York.
    expect(addDays('2026-03-05', 10)).toBe('2026-03-15');
  });

  it('crosses the US fall-back boundary', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('handles month, year and leap-day boundaries', () => {
    expect(addDays('2026-06-01', 2)).toBe('2026-06-03');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('rewinds on a negative offset (constraints walk backwards from a pin)', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-15', -10)).toBe('2026-03-05');
  });

  it('accepts a timestamp and returns the date part', () => {
    expect(addDays('2026-03-05T00:00:00Z', 10)).toBe('2026-03-15');
  });

  it('returns a malformed input unchanged', () => {
    expect(addDays('soon', 3)).toBe('soon');
    expect(addDays('', 3)).toBe('');
  });

  it('chains the way the optimizer assigns city dates', () => {
    // nights [3, 2, 2] from 03-05: under America/New_York the old Date
    // cursor gave the second city a single night (03-08 → 03-09).
    let cursor = '2026-03-05';
    const out: Array<[string, string]> = [];
    for (const nights of [3, 2, 2]) {
      const departure = addDays(cursor, nights);
      out.push([cursor, departure]);
      cursor = departure;
    }
    expect(out).toEqual([
      ['2026-03-05', '2026-03-08'],
      ['2026-03-08', '2026-03-10'],
      ['2026-03-10', '2026-03-12'],
    ]);
  });
});

describe('clampToFuture', () => {
  /**
   * Clock frozen, and the expected values spelled out as literal dates.
   *
   * `clampToFuture` reads `todayIso()` internally, and these tests used to
   * read it again to build both the input and the expectation — two reads of
   * the real clock that have to agree on the calendar day. That is the same
   * shape as the flights retry flake, with a one-millisecond window per day
   * instead of per second, so it only ever goes red on a run that straddles
   * UTC midnight.
   *
   * Freezing matters less for that than for what it removes: comparing
   * against `todayIso()` was close to tautological. The old
   * `clampToFuture(todayIso())` vs `todayIso()` passes even when both agree
   * on the WRONG day — a local-zone `todayIso()` returning 2026-03-04 west
   * of UTC gives '2026-03-04' on both sides and goes green, which is exactly
   * the regression the test name claims to cover. A literal cannot do that.
   *
   * 02:30 UTC is deliberate: under TZ=America/New_York the local date at
   * that instant is still 2026-03-04, so a zone-dependent implementation
   * fails these assertions instead of sliding past them. The header note
   * still holds — everything asserted here is a literal UTC date, so it
   * passes under every TZ.
   */
  const FROZEN_NOW = '2026-03-05T02:30:00.000Z';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FROZEN_NOW));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('leaves today alone (old version pushed it to tomorrow west of UTC)', () => {
    expect(todayIso()).toBe('2026-03-05');
    expect(clampToFuture('2026-03-05')).toBe('2026-03-05');
  });

  it('leaves a future date alone', () => {
    // 30 days on from the frozen today, across the US spring-forward.
    expect(addDays(todayIso(), 30)).toBe('2026-04-04');
    expect(clampToFuture('2026-04-04')).toBe('2026-04-04');
  });

  it('pushes a past date to tomorrow (old version returned today east of UTC)', () => {
    expect(clampToFuture('2026-03-04')).toBe('2026-03-06');
    expect(clampToFuture('2020-01-01')).toBe('2026-03-06');
  });
});
