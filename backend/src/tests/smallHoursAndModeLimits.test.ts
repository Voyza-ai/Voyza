// These pure pick rules import modules that load config/env, whose schema
// needs Supabase credentials at import time. Mocked like legPriceCache.test.ts
// so the suite runs on a machine without the deployed backend's secrets.
jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
  },
}));

/**
 * Two pick rules, shared by the planner and the AI chat:
 *
 *  - Small hours (longJourney.ts): an option leaving or arriving 00:00–04:59
 *    goes after every priced option at sensible hours. Production picked
 *    Prague → Vienna as a 00:36 train ($120) and Salzburg → Prague at 00:13 to
 *    save $26.
 *  - "Switch this leg" (tripLegs.ts journeyLimit) judges a long journey within
 *    its own mode, like the planner — never a train against a flight.
 */
import { cheapestSensible, comparePick, inSmallHours, sensibleFirst } from '../services/longJourney';
import { orderLegOptions, type LegOption } from '../services/legOptions';
import { isLongJourney, journeyLimit, limitFor, type LegChoice } from '../services/tripLegs';

describe('inSmallHours', () => {
  it.each([
    [{ departTime: '00:36', arriveTime: '07:29' }, true],
    [{ departTime: '04:59', arriveTime: '09:00' }, true],
    [{ departTime: '19:07', arriveTime: '03:09' }, true],
    [{ departTime: '05:00', arriveTime: '09:00' }, false],
    // A night train: evening out, morning in.
    [{ departTime: '22:10', arriveTime: '07:05' }, false],
    [{ departure: '2027-03-19T00:13', arrival: '2027-03-19T09:23' }, true],
    [{ departure: '2027-03-19T11:11:00', arrival: '2027-03-19T18:23:00' }, false],
    [{}, false],
  ])('%j → %s', (o, want) => {
    expect(inSmallHours(o)).toBe(want);
  });
});

describe('sensibleFirst / cheapestSensible', () => {
  const t = (price: number | null, dep: string, arr: string, durationMinutes = 300) => ({ price, departTime: dep, arriveTime: arr, durationMinutes });

  it('Prague → Vienna: the $150 daytime train beats the $120 one at 00:36', () => {
    const night = t(120, '00:36', '07:29', 413);
    const day = t(150, '08:12', '12:16', 244);
    expect(cheapestSensible([night, day])).toBe(day);
  });

  it('a priced small-hours option still beats an unpriced daytime one', () => {
    const night = t(120, '00:36', '07:29');
    const unpriced = t(null, '08:12', '12:16');
    expect(cheapestSensible([unpriced, night])).toBe(night);
  });

  it('a lone small-hours option is still offered', () => {
    const night = t(120, '00:36', '07:29');
    expect(cheapestSensible([night])).toBe(night);
  });

  it('long journeys still go after small hours', () => {
    const night = t(120, '00:36', '07:29', 300);
    const long = t(60, '09:00', '12:00', 2400);
    expect(sensibleFirst([long, night])).toEqual([night, long]);
  });

  it('ordinary daytime options: cheapest first, unchanged', () => {
    const a = t(90, '09:00', '14:00');
    const b = t(140, '08:00', '12:20');
    expect(cheapestSensible([b, a])).toBe(a);
    expect([b, a].sort(comparePick)).toEqual([a, b]);
  });
});

describe('orderLegOptions (the leg card)', () => {
  const opt = (mode: 'flight' | 'train', price: number, departTime: string, arriveTime: string, durationMinutes: number): LegOption =>
    ({ mode, price, departTime, arriveTime, durationMinutes, operator: `${mode}-${departTime}` }) as unknown as LegOption;

  it('puts the 00:36 train after every option at sensible hours', () => {
    const night = opt('train', 120, '00:36', '07:29', 413);
    const day = opt('train', 150, '08:12', '12:16', 244);
    const flight = opt('flight', 336, '21:50', '22:40', 50);
    expect(orderLegOptions([night, flight, day], 4)).toEqual([day, flight, night]);
  });
});

describe('switch this leg: long within a mode', () => {
  const c = (mode: 'flight' | 'train', durationMinutes: number): LegChoice => ({ mode, durationMinutes } as unknown as LegChoice);

  it('a 4h 03m train is not long next to a 1h flight', () => {
    const train = c('train', 243);
    const flight = c('flight', 60);
    const limit = journeyLimit([train, flight]);
    expect(isLongJourney(train, limit)).toBe(false);
  });

  it('a 30h flight is still long next to an 8h flight', () => {
    const slow = c('flight', 1830);
    const limit = journeyLimit([slow, c('flight', 480)]);
    expect(isLongJourney(slow, limit)).toBe(true);
    expect(limitFor(limit, [slow])).toBe(960);
  });

  it('a 39h train is long next to a 5h 37m train', () => {
    const long = c('train', 2352);
    expect(isLongJourney(long, journeyLimit([long, c('train', 337)]))).toBe(true);
  });

  it('no limit (an airline the user named): nothing is long', () => {
    expect(isLongJourney(c('flight', 1830), null)).toBe(false);
  });
});
