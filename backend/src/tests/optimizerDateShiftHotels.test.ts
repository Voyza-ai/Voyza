jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

/**
 * "Start 2 days earlier and save $X" must be true of the TRIP, not just its
 * flights.
 *
 * The date-shift probe re-priced the inter-city legs and the home flights at
 * each shifted start date and offered the cheapest — but a shift moves every
 * hotel night too, and hotels were never re-priced. A Friday-to-Saturday
 * shift, a holiday, a festival week: the flights get cheaper, the stays get
 * dearer, and the banner promised a saving the traveller would never see.
 *
 * Now the single best transport candidate (and only that one — every hotel
 * search spends RapidAPI quota) has its hotels priced at both the requested
 * and the shifted dates, the way the planner will price them: same city,
 * dates, party and rooms, the planner's own pick per city. The shift is
 * offered only if transport + hotels still clears the existing thresholds,
 * and never when a hotel search comes back empty.
 */

jest.mock('../services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
});

// IATA = first three letters, upper-cased ("Alpha" → ALP, "Home" → HOM).
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

// The real hotel module (plannerHotelPick, roomsFor) with only the provider
// search replaced.
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn(),
}));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchHotels, type HotelResult } from '../services/hotels';

const mockedFlights = searchFlights as jest.Mock;
const mockedHotels = searchHotels as jest.Mock;

const offer = (price: number, arrival = '') => ({
  id: `f-${price}`,
  price,
  durationMinutes: 120,
  carrier: 'Test Air',
  carrierCode: 'TA',
  departure: '',
  arrival,
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

const hotel = (name: string, pricePerNight: number, nights: number, extra: Partial<HotelResult> = {}): HotelResult => ({
  id: name,
  name,
  price: pricePerNight * nights,
  pricePerNight,
  currency: 'USD',
  rating: 8.5,
  reviewCount: 800,
  stars: 3,
  thumbnail: '',
  bookingUrl: '',
  amenities: [],
  ...extra,
});

const nightsOf = (checkin: string, checkout: string) => Math.round((Date.parse(checkout) - Date.parse(checkin)) / 864e5);

/** A one-row search per stay, priced per night by `perNight(city, checkin)`. */
function priceHotels(perNight: (city: string, checkin: string) => number | null) {
  mockedHotels.mockImplementation(async ({ city, checkin, checkout }: any) => {
    const p = perNight(city, checkin);
    return p === null ? [] : [hotel(`${city} Hotel`, p, nightsOf(checkin, checkout))];
  });
}

/**
 * One city, Alpha, from Home, 3 nights from June 10. The outbound is $600 on
 * June 10 and $300 two days earlier; everything else is $100. Transport alone
 * saves $300 by starting June 8 — the case the old probe offered.
 */
const cheaperTwoDaysEarly = () =>
  mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
    if (origin === 'HOM' && destination === 'ALP') return [offer(date === '2030-06-08' ? 300 : 600)];
    return [offer(100)];
  });

const oneCityTrip = { cities: [{ name: 'Alpha' }], startDate: '2030-06-10', travelers: 4, origin: 'Home', originAirports: ['HOM'], returnToHome: true, totalNights: 3 };

beforeEach(() => jest.clearAllMocks());

describe('the date-shift saving counts the hotels the shift moves', () => {
  it('hotels dearer on the shifted dates than the flights save: no suggestion', async () => {
    cheaperTwoDaysEarly();
    // $100 a night as planned; $250 a night two days earlier — +$450 over
    // three nights against $300 saved on the flight.
    priceHotels((_c, checkin) => (checkin === '2030-06-08' ? 250 : 100));

    const result = await optimize(oneCityTrip);

    expect(result.dateShiftSuggestion).toBeUndefined();
  }, 30000);

  it('hotels cheaper on the shifted dates: the saving and the new total include them', async () => {
    cheaperTwoDaysEarly();
    priceHotels((_c, checkin) => (checkin === '2030-06-08' ? 80 : 100));

    const result = await optimize(oneCityTrip);
    const s = result.dateShiftSuggestion!;

    expect(s).toBeDefined();
    expect(s.dayOffset).toBe(-2);
    // Flights 700 → 400, hotels 300 → 240.
    expect(s.savings).toBe(360);
    expect(s.newTotalCost).toBe(640);
    expect(s.options).toEqual([{ dayOffset: -2, newStartDate: '2030-06-08', newTotalCost: 640, savings: 360 }]);
  }, 30000);

  it('a hotel saving that leaves the total under the threshold is not offered', async () => {
    cheaperTwoDaysEarly();
    // +$280 of hotels against $300 of flights: $20 left, under the $50 bar.
    priceHotels((_c, checkin) => (checkin === '2030-06-08' ? 100 + 280 / 3 : 100));

    expect((await optimize(oneCityTrip)).dateShiftSuggestion).toBeUndefined();
  }, 30000);

  it('counts the excluded charges the trip total counts', async () => {
    cheaperTwoDaysEarly();
    // Same room rate on both dates, but $120 a night of city tax and fees on
    // the shifted dates: +$360, more than the $300 the flight saves.
    mockedHotels.mockImplementation(async ({ city, checkin, checkout }: any) => [
      hotel(`${city} Hotel`, 100, nightsOf(checkin, checkout), { taxesPerNight: checkin === '2030-06-08' ? 120 : 0 }),
    ]);

    expect((await optimize(oneCityTrip)).dateShiftSuggestion).toBeUndefined();
  }, 30000);

  it('prices the hotel the planner will pick, not the cheapest one', async () => {
    cheaperTwoDaysEarly();
    // The 9.4 at $100 is the planner's pick on both dates; it goes to $160
    // when shifted (+$180 over three nights). A cheapest-row comparison would
    // see the flat $90 6.0 and call the hotels unchanged.
    mockedHotels.mockImplementation(async ({ checkin, checkout }: any) => {
      const n = nightsOf(checkin, checkout);
      return [
        hotel('Rated', checkin === '2030-06-08' ? 160 : 100, n, { rating: 9.4 }),
        hotel('Cheap', 90, n, { rating: 6.0 }),
      ];
    });

    const s = (await optimize(oneCityTrip)).dateShiftSuggestion!;
    expect(s).toBeDefined();
    expect(s.savings).toBe(120);
  }, 30000);
});

describe('no suggestion is better than a wrong one', () => {
  it('a hotel search that comes back empty on the shifted dates: no suggestion', async () => {
    cheaperTwoDaysEarly();
    priceHotels((_c, checkin) => (checkin === '2030-06-08' ? null : 100));

    expect((await optimize(oneCityTrip)).dateShiftSuggestion).toBeUndefined();
  }, 30000);

  it('a hotel search that throws: no suggestion, and the trip itself still comes back', async () => {
    cheaperTwoDaysEarly();
    mockedHotels.mockRejectedValue(new Error('Booking down'));

    const result = await optimize(oneCityTrip);
    expect(result.dateShiftSuggestion).toBeUndefined();
    expect(result.bestRoute.ordering).toEqual(['Alpha']);
  }, 30000);
});

describe('quota: one candidate, searched exactly as the planner will search it', () => {
  it('re-prices only the best shift, and only once per stay', async () => {
    // Two cities. -2 saves $300 on the outbound, +1 saves $200 on the return:
    // both clear the transport thresholds, only -2 is re-priced.
    mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      if (origin === 'HOM' && destination === 'ALP') return [offer(date === '2030-06-08' ? 300 : 600)];
      if (origin === 'BRA' && destination === 'HOM') return [offer(date === '2030-06-15' ? 400 : 600)];
      if (origin === 'HOM' || destination === 'HOM') return [offer(5000)];
      return [offer(100)];
    });
    priceHotels(() => 100);

    const result = await optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }],
      startDate: '2030-06-10',
      travelers: 3,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 4,
    });

    expect(result.bestRoute.ordering).toEqual(['Alpha', 'Bravo']);
    const s = result.dateShiftSuggestion!;
    expect(s.dayOffset).toBe(-2);
    expect(s.options).toHaveLength(1);

    // Two stays × (as planned + shifted) = 4 searches, nothing for +1.
    const calls = mockedHotels.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(
      expect.arrayContaining([
        // Exactly the planner's request — no rooms, no price cap — so the
        // searches it makes next are answered from the 10-minute cache.
        { city: 'Alpha', checkin: '2030-06-10', checkout: '2030-06-12', adults: 3 },
        { city: 'Bravo', checkin: '2030-06-12', checkout: '2030-06-14', adults: 3 },
        { city: 'Alpha', checkin: '2030-06-08', checkout: '2030-06-10', adults: 3 },
        { city: 'Bravo', checkin: '2030-06-10', checkout: '2030-06-12', adults: 3 },
      ]),
    );
    // And the planned stays are the ones the trip shows.
    expect(result.dates).toEqual({
      Alpha: { arrival: '2030-06-10', departure: '2030-06-12' },
      Bravo: { arrival: '2030-06-12', departure: '2030-06-14' },
    });
  }, 30000);

  it('the first stay starts when the outbound lands, as the trip shows it', async () => {
    // Overnight outbound: leaves June 10, lands June 11 (June 8 → June 9 when
    // shifted). The first stay is searched from the landing date both times.
    mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      if (origin === 'HOM' && destination === 'ALP') {
        return date === '2030-06-08' ? [offer(300, '2030-06-09T08:00:00')] : [offer(600, '2030-06-11T08:00:00')];
      }
      return [offer(100)];
    });
    priceHotels(() => 100);

    const result = await optimize(oneCityTrip);

    expect(result.dates.Alpha).toEqual({ arrival: '2030-06-11', departure: '2030-06-13' });
    const calls = mockedHotels.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining([
        { city: 'Alpha', checkin: '2030-06-11', checkout: '2030-06-13', adults: 4 },
        { city: 'Alpha', checkin: '2030-06-09', checkout: '2030-06-11', adults: 4 },
      ]),
    );
    expect(result.dateShiftSuggestion?.savings).toBe(300);
  }, 30000);

  it('no transport saving, no hotel searches at all', async () => {
    mockedFlights.mockImplementation(async () => [offer(100)]);
    priceHotels(() => 100);

    const result = await optimize(oneCityTrip);

    expect(result.dateShiftSuggestion).toBeUndefined();
    expect(mockedHotels).not.toHaveBeenCalled();
  }, 30000);
});

/**
 * `plannerHotelPick` mirrors frontend/lib/hotelScore.ts `rankHotels()[0]` —
 * the hotel PlanningChat puts in the trip. Expected picks below are what the
 * frontend's own function returns for these lists (run against it directly;
 * 5,000 random lists with zero, negative, NaN and flagged rows agreed too).
 */
describe('plannerHotelPick picks what the planner picks', () => {
  const { plannerHotelPick } = jest.requireActual('../services/hotels') as typeof import('../services/hotels');
  const h = (name: string, rating: number, pricePerNight: number, extra: Partial<HotelResult> = {}) =>
    hotel(name, pricePerNight, 1, { rating, reviewCount: 500, ...extra });
  const florence = [
    h('Hotel David', 8.6, 204.32),
    h('Radisson Blu', 8.4, 170.31),
    h('B&B Laurus al Duomo', 8.8, 301.99),
    h('Plus Florence', 8.1, 159.87),
    h('Il Bargello', 9.0, 197.58),
  ];

  it.each([
    ['a real Florence search', florence, 'Il Bargello'],
    ['a $0 row is never the pick', [...florence, h('Zero', 9, 0)], 'Il Bargello'],
    ['a flagged row is never the pick while a trusted one exists', [...florence, h('Cheap glitch', 9, 3, { priceSuspect: true })], 'Il Bargello'],
    ['every row flagged: the best of them, as the planner does', [h('A', 8, 100, { priceSuspect: true }), h('B', 9, 100, { priceSuspect: true })], 'B'],
  ])('%s', (_label, rows, expected) => {
    expect(plannerHotelPick(rows as HotelResult[])?.name).toBe(expected);
  });

  it('nothing to pick from', () => {
    expect(plannerHotelPick([])).toBeUndefined();
  });
});
