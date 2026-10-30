/**
 * The validators the AI chat runs before proposing a date change (B10).
 * The route-level behaviour is in planChatTools.test.ts; these pin down the
 * boundaries — the one-day "today" slack, the 60-night cap, and that the
 * schedule check only blames what a proposal changed.
 */
import {
  earliestAllowedDate,
  isIsoDate,
  MAX_STAY_NIGHTS,
  minDaysProblem,
  parseMinNights,
  pinProblem,
  scheduleProblem,
} from '../services/constraints';

const TODAY = '2026-10-30';

describe('isIsoDate', () => {
  it.each(['2026-12-09', '2028-02-29', '2026-01-01'])('accepts %p', (s) => {
    expect(isIsoDate(s)).toBe(true);
  });
  it.each(['Dec 9', '2026-12-9', '2026-02-30', '2027-02-29', '2026-13-01', '2026-12-09T00:00:00Z', ' 2026-12-09', '', null, 20261209])(
    'rejects %p',
    (s) => {
      expect(isIsoDate(s)).toBe(false);
    },
  );
});

describe('pinProblem', () => {
  it('allows UTC-yesterday (a user west of UTC in the evening) but not the day before', () => {
    expect(earliestAllowedDate(TODAY)).toBe('2026-10-29');
    expect(pinProblem('2026-10-29', '2026-10-31', TODAY)).toBeNull();
    expect(pinProblem('2026-10-28', '2026-10-31', TODAY)).toBe('those dates have already passed');
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(earliestAllowedDate('2027-01-01')).toBe('2026-12-31');
    expect(pinProblem('2026-12-31', '2027-01-02', '2027-01-01')).toBeNull();
  });

  it('requires departure after arrival', () => {
    expect(pinProblem('2026-12-20', '2026-12-18', TODAY)).toMatch(/after the arrival/);
    expect(pinProblem('2026-12-20', '2026-12-20', TODAY)).toMatch(/after the arrival/);
  });

  it(`caps a pin at ${MAX_STAY_NIGHTS} nights`, () => {
    expect(pinProblem('2026-12-01', '2027-01-30', TODAY)).toBeNull(); // 60
    expect(pinProblem('2026-12-01', '2027-01-31', TODAY)).toMatch(/61 nights/);
  });

  it('names what it got when a date is not ISO', () => {
    expect(pinProblem('Dec 9', 'Dec 12', TODAY)).toBe('I need real dates written YYYY-MM-DD, and got "Dec 9" to "Dec 12"');
  });
});

describe('parseMinNights', () => {
  it.each([[1, 1], [3, 3], [60, 60], ['3', 3], [' 4 ', 4]])('%p → %p', (raw, want) => {
    expect(parseMinNights(raw)).toBe(want);
  });
  it.each([0, -1, 61, 400, 2.5, '2.5', 'three', '', null, undefined, NaN, Infinity, true])('rejects %p', (raw) => {
    expect(parseMinNights(raw)).toBeNull();
  });
});

describe('scheduleProblem', () => {
  const city = (name: string, arrival_date: string | null, departure_date: string | null) => ({ name, arrival_date, departure_date });
  const trip = [city('Rome', '2026-12-08', '2026-12-10'), city('Venice', '2026-12-10', '2026-12-12'), city('Florence', '2026-12-12', '2026-12-14')];

  it('accepts a clean chain', () => {
    const after = [city('Rome', '2026-12-09', '2026-12-11'), city('Venice', '2026-12-11', '2026-12-13'), city('Florence', '2026-12-13', '2026-12-15')];
    expect(scheduleProblem(trip, after, TODAY)).toBeNull();
  });

  it('flags a moved city that now starts in the past, naming it', () => {
    const after = [city('Rome', '2026-10-27', '2026-10-29'), city('Venice', '2026-10-29', '2026-10-31'), city('Florence', '2026-10-31', '2026-11-02')];
    expect(scheduleProblem(trip, after, TODAY)).toBe('Rome would start on 2026-10-27, which has already passed');
  });

  it('does not blame a city the proposal did not move (a trip already under way)', () => {
    const underway = [city('Rome', '2026-10-25', '2026-10-28'), city('Venice', '2026-10-28', '2026-11-01')];
    const after = [city('Rome', '2026-10-25', '2026-10-28'), city('Venice', '2026-10-28', '2026-11-03')];
    expect(scheduleProblem(underway, after, TODAY)).toBeNull();
  });

  it('flags a new overlap between consecutive stays', () => {
    const after = [city('Rome', '2026-12-08', '2026-12-12'), city('Venice', '2026-12-11', '2026-12-13'), city('Florence', '2026-12-13', '2026-12-15')];
    expect(scheduleProblem(trip, after, TODAY)).toBe('Rome (until 2026-12-12) and Venice (from 2026-12-11) would overlap');
  });

  it('ignores an overlap the trip already had, and a gap (an overnight leg)', () => {
    const odd = [city('Rome', '2026-12-08', '2026-12-11'), city('Venice', '2026-12-10', '2026-12-12')];
    expect(scheduleProblem(odd, odd, TODAY)).toBeNull();
    const gap = [city('Rome', '2026-12-08', '2026-12-10'), city('Venice', '2026-12-11', '2026-12-13')];
    expect(scheduleProblem(trip.slice(0, 2), gap, TODAY)).toBeNull();
  });

  it('skips cities without dates', () => {
    const undated = [city('Rome', null, null), city('Venice', '2026-12-10', '2026-12-12')];
    expect(scheduleProblem(undated, undated, TODAY)).toBeNull();
  });
});

describe('minDaysProblem', () => {
  const rome = { name: 'Rome', arrival_date: '2026-12-08', departure_date: '2026-12-12' };

  it('is satisfied when the city has at least that many nights', () => {
    expect(minDaysProblem(rome, 4, {})).toBeNull();
  });

  it('names the pin that kept it short', () => {
    const constraints = { pinned_cities: [{ city: 'rome', arrival: '2026-12-08', departure: '2026-12-12' }] };
    expect(minDaysProblem(rome, 6, constraints)).toBe("it's pinned to 2026-12-08 – 2026-12-12 (4 nights)");
  });

  it('says so when the city has no dates', () => {
    expect(minDaysProblem({ name: 'Rome', arrival_date: null, departure_date: null }, 3, {})).toBe('Rome has no dates yet');
  });
});
