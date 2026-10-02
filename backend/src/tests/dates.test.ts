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
  it('leaves today alone (old version pushed it to tomorrow west of UTC)', () => {
    expect(clampToFuture(todayIso())).toBe(todayIso());
  });

  it('leaves a future date alone', () => {
    const future = addDays(todayIso(), 30);
    expect(clampToFuture(future)).toBe(future);
  });

  it('pushes a past date to tomorrow (old version returned today east of UTC)', () => {
    const tomorrow = addDays(todayIso(), 1);
    expect(clampToFuture(addDays(todayIso(), -1))).toBe(tomorrow);
    expect(clampToFuture('2020-01-01')).toBe(tomorrow);
  });
});
