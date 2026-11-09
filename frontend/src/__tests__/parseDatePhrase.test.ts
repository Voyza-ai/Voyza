/**
 * A month or season named inside a phrase is the date, not "a month from
 * today" (found live: "sometime in April" planned a trip for Dec 8).
 */
import { parseDateInput } from '@/lib/parseDate';

beforeAll(() => {
  jest.useFakeTimers({ now: new Date(2026, 10, 9) }); // 9 Nov 2026
});
afterAll(() => jest.useRealTimers());

describe('parseDateInput — month or season inside a phrase', () => {
  it.each([
    ['sometime in April', '2027-04-01'],
    ['Sometime in April!', '2027-04-01'],
    ['early june', '2027-06-01'],
    ['mid-October', '2027-10-10'],
    ['late December', '2026-12-20'],
    ['end of January', '2027-01-20'],
    ['probably in april 2028', '2028-04-01'],
    ['in May', '2027-05-01'],
    ['we may go in June', '2027-06-01'],
    ['late summer', '2027-07-20'],
    ['sometime next spring', '2027-04-01'],
  ])('%s → %s', (input, expected) => {
    expect(parseDateInput(input)).toBe(expected);
  });

  it('a phrase with no month or season still falls back', () => {
    expect(parseDateInput('whenever works')).toBe('2026-12-09');
    expect(parseDateInput('we may go soon')).toBe('2026-12-09');
  });

  it('a named past year means the next one of that month', () => {
    expect(parseDateInput('sometime in April 2025')).toBe('2027-04-01');
  });

  it('existing forms are unchanged', () => {
    expect(parseDateInput('April')).toBe('2027-04-01');
    expect(parseDateInput('June 15, 2027')).toBe('2027-06-15');
    expect(parseDateInput('next week')).toBe('2026-11-16');
  });
});
