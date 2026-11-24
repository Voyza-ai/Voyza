/**
 * Which of a day's All Aboard journeys get live-priced.
 *
 * It used to be three — first, middle and last of the day — whatever they
 * were. Live, 2027-03-19/20 (probed 2026-11-23): Vienna → Munich has 20
 * journeys and the three were a 05:38, the 13:13 and a 22:44 sleeper that
 * has no fares; Munich → Prague's last was a 39h three-ticket journey. Now:
 * up to OFFER_CANDIDATES (6), never a long journey (longJourney.ts's rule),
 * daytime departures first, spread across the day.
 */
jest.mock('../config/env', () => ({
  env: {
    ALLABOARD_API_KEY: 'k_test_key',
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import {
  clearLocationCache,
  OFFER_CANDIDATES,
  searchAllAboardDetailed,
} from '../services/allaboard';

const gqlOk = (data: any) => ({ ok: true, json: () => Promise.resolve({ data }) });

/** [departure, arrival] local times; arrival before departure = next day. */
type Slot = [string, string];

// Vienna → Munich, 2027-03-20, as All Aboard's test gateway returned it.
const VIENNA_MUNICH: Slot[] = [
  ['05:38', '11:50'], ['06:28', '11:23'], ['07:13', '12:16'], ['08:13', '12:37'],
  ['08:28', '13:23'], ['09:28', '14:13'], ['10:28', '15:23'], ['11:13', '16:16'],
  ['12:13', '16:37'], ['12:28', '17:23'], ['13:13', '18:16'], ['14:28', '19:23'],
  ['15:28', '20:13'], ['16:28', '21:23'], ['17:13', '22:16'], ['18:28', '23:23'],
  ['19:13', '00:37'], ['21:57', '03:19'], ['22:28', '06:05'], ['22:44', '06:05'],
];

function journeysFor(date: string, slots: Slot[], extraDays: number[] = []) {
  return slots.map(([dep, arr], i) => {
    const nextDay = arr < dep ? 1 : 0;
    const days = nextDay + (extraDays[i] ?? 0);
    const arrDate = new Date(`${date}T00:00:00Z`);
    arrDate.setUTCDate(arrDate.getUTCDate() + days);
    return {
      id: `j${i}`,
      status: 'SUCCESS',
      itinerary: [
        {
          status: 'SUCCESS',
          segments: [
            {
              origin: { name: 'A' },
              destination: { name: 'B' },
              departureAt: `${date}T${dep}:00+01:00`,
              arrivalAt: `${arrDate.toISOString().slice(0, 10)}T${arr}:00+01:00`,
              operator: { name: 'ÖBB' },
            },
          ],
        },
      ],
    };
  });
}

/** Every journey has a fare: $100 + its index, for the party. */
function serve(journeys: any[]) {
  mockFetch.mockImplementation((_url: string, init: any) => {
    const body = String(init?.body ?? '');
    if (body.includes('getLocations')) {
      const q = JSON.parse(body).variables.q;
      return Promise.resolve(gqlOk({ getLocations: [{ uid: `uid-${q}`, name: q }] }));
    }
    if (body.includes('getJourneys')) return Promise.resolve(gqlOk({ getJourneys: journeys }));
    if (body.includes('getJourneyOffer')) {
      const id: string = JSON.parse(body).variables.j;
      const cents = (100 + Number(id.slice(1))) * 100;
      return Promise.resolve(
        gqlOk({ getJourneyOffer: { itinerary: [{ status: 'SUCCESS', offers: [{ id: 'o', price: { amount: cents, currency: 'USD' } }] }] } }),
      );
    }
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  });
}

const offerIds = () =>
  mockFetch.mock.calls
    .map(([, init]: any) => String(init?.body ?? ''))
    .filter((b) => b.includes('getJourneyOffer'))
    .map((b) => JSON.parse(b).variables.j as string)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

const params = (origin: string, destination: string, date: string) => ({ origin, destination, date, travelers: 2 });

beforeEach(() => {
  jest.clearAllMocks();
  clearLocationCache();
});

describe('All Aboard: which journeys get priced', () => {
  it('Vienna → Munich: six daytime trains spread over the day, not the 05:38 and the 22:44 sleeper', async () => {
    serve(journeysFor('2027-03-20', VIENNA_MUNICH));
    const { offers, complete } = await searchAllAboardDetailed(params('Vienna', 'Munich', '2027-03-20'));

    expect(OFFER_CANDIDATES).toBe(6);
    const asked = offerIds();
    expect(asked).toHaveLength(6);
    expect(asked).not.toContain('j0'); // 05:38
    expect(asked).not.toContain('j19'); // 22:44 sleeper
    // Daytime (06:00–21:00) only, morning to evening.
    const hours = asked.map((id) => Number(VIENNA_MUNICH[Number(id.slice(1))][0].slice(0, 2)));
    expect(hours.every((h) => h >= 6 && h < 21)).toBe(true);
    expect(Math.min(...hours)).toBeLessThan(9);
    expect(Math.max(...hours)).toBeGreaterThanOrEqual(18);

    expect(complete).toBe(true);
    expect(offers.filter((o) => o.pricePerPerson != null)).toHaveLength(6);
  });

  it('never spends a fare request on a long journey (Munich → Prague: the 39h three-ticket one)', async () => {
    const slots: Slot[] = [
      ['04:44', '10:21'], ['06:44', '12:21'], ['08:44', '14:21'], ['10:44', '16:21'],
      ['12:44', '18:21'], ['14:44', '20:21'], ['16:44', '22:21'], ['23:09', '14:21'],
    ];
    // The last one arrives two days later: 39h12.
    serve(journeysFor('2027-03-19', slots, [0, 0, 0, 0, 0, 0, 0, 1]));
    await searchAllAboardDetailed(params('Munich', 'Prague', '2027-03-19'));

    const asked = offerIds();
    expect(asked).not.toContain('j7');
    expect(asked).not.toContain('j0'); // 04:44, while six daytime trains are left
    expect(asked).toEqual(['j1', 'j2', 'j3', 'j4', 'j5', 'j6']);
  });

  it('fills spare slots with night trains when there are few daytime ones', async () => {
    const slots: Slot[] = [['00:36', '07:29'], ['05:36', '09:49'], ['11:36', '15:49'], ['22:10', '02:30']];
    serve(journeysFor('2027-03-20', slots));
    await searchAllAboardDetailed(params('Prague', 'Vienna', '2027-03-20'));
    expect(offerIds()).toEqual(['j0', 'j1', 'j2', 'j3']);
  });

  it('a short day is priced whole', async () => {
    serve(journeysFor('2027-03-20', [['09:00', '12:00'], ['15:00', '18:00']]));
    const { offers } = await searchAllAboardDetailed(params('Graz', 'Linz', '2027-03-20'));
    expect(offerIds()).toEqual(['j0', 'j1']);
    expect(offers.map((o) => o.pricePerPerson)).toEqual([50, 50.5]);
  });

  it('costs at most 2 lookups + 1 timetable + 6 fare requests however many trains run', async () => {
    const many: Slot[] = Array.from({ length: 40 }, (_, i) => {
      const m = 6 * 60 + i * 20;
      const hhmm = (x: number) => `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
      return [hhmm(m), hhmm(m + 150)];
    });
    serve(journeysFor('2027-03-20', many));
    await searchAllAboardDetailed(params('Zurich', 'Milan', '2027-03-20'));
    expect(mockFetch).toHaveBeenCalledTimes(2 + 1 + 6);
  });
});
