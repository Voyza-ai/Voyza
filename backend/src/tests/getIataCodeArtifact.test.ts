/**
 * `getIataCode` asks the artifact before the cache, and checks Duffel before
 * trusting or caching it.
 *
 * It used to go curated table -> `airport_codes` cache -> Duffel's first
 * suggestion, cached forever, and never asked the 36,009-place artifact.
 * Duffel's place search is fuzzy, and production holds the result. Measured
 * live: Siena -> JHB (Senai, Malaysia), Sintra -> SQG (Sintang, Indonesia),
 * Bath -> BUT (Bathpalathang, Bhutan), Monteverde -> MVD (Montevideo,
 * Uruguay). Those rows are still in the database — nothing here deletes them
 * — so the cases below put them back into a mocked cache and require that
 * none of them is ever served again.
 *
 * Duffel and Supabase are mocked; the artifact is the real checked-in one.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

/** `airport_codes`, as production may hold it. Keyed by lower-cased name. */
const mockCache: Record<string, { iata_code: string; country: string | null }> = {};
const mockReads: string[] = [];
const mockUpserts: Array<Record<string, unknown>> = [];

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          single: () => {
            mockReads.push(value);
            return Promise.resolve({ data: mockCache[value] ?? null });
          },
        }),
      }),
      upsert: (row: Record<string, unknown>) => {
        mockUpserts.push(row);
        return Promise.resolve({ data: null });
      },
    }),
  }),
}));

jest.mock('../services/duffel', () => {
  const mockDuffel = { offerRequests: { create: jest.fn() }, suggestions: { list: jest.fn() } };
  return { getDuffel: () => mockDuffel, __mockDuffel: mockDuffel };
});

import { getIataCode } from '../services/flights';
import { namedAsAsked } from '../services/location/destinationAirport';

const { __mockDuffel: mockDuffel } = require('../services/duffel');

/** Duffel airport places, with the fields a real response carries. */
const DUFFEL = {
  JHB: { type: 'airport', iata_code: 'JHB', iata_country_code: 'MY', name: 'Senai International Airport', city_name: 'Johor Bahru', latitude: 1.6413, longitude: 103.67 },
  SQG: { type: 'airport', iata_code: 'SQG', iata_country_code: 'ID', name: 'Tebelian Airport', city_name: 'Sintang', latitude: 0.0636, longitude: 111.473 },
  BUT: { type: 'airport', iata_code: 'BUT', iata_country_code: 'BT', name: 'Bathpalathang Airport', city_name: 'Jakar', latitude: 27.5622, longitude: 90.7471 },
  MVD: { type: 'airport', iata_code: 'MVD', iata_country_code: 'UY', name: 'Carrasco International Airport', city_name: 'Montevideo', latitude: -34.8384, longitude: -56.0308 },
  ZRH: { type: 'airport', iata_code: 'ZRH', iata_country_code: 'CH', name: 'Zürich Airport', city_name: 'Zurich', latitude: 47.4647, longitude: 8.5492 },
  LHR: { type: 'airport', iata_code: 'LHR', iata_country_code: 'GB', name: 'Heathrow Airport', city_name: 'London', latitude: 51.47, longitude: -0.4543 },
};

const suggest = (...places: object[]) =>
  mockDuffel.suggestions.list.mockResolvedValue({ data: places });

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockCache)) delete mockCache[key];
  mockReads.length = 0;
  mockUpserts.length = 0;
  suggest();
});

// The first lookup builds the resolver index (~1 s); a busy machine needs room.
jest.setTimeout(30_000);

describe('the artifact answers before the cache', () => {
  it.each([
    ['Siena', 'FLR', 'JHB', 'MY'],
    ['Sintra', 'LIS', 'SQG', 'ID'],
    ['Bath', 'BRS', 'BUT', 'BT'],
  ])('%s is %s, and the cached %s (%s) is never read', async (city, expected, wrong, country) => {
    // The production row, and Duffel still suggesting it: neither may win.
    mockCache[city.toLowerCase()] = { iata_code: wrong, country };
    suggest(DUFFEL[wrong as keyof typeof DUFFEL]);

    expect(await getIataCode(city)).toBe(expected);
    expect(mockReads).toEqual([]);
    expect(mockDuffel.suggestions.list).not.toHaveBeenCalled();
    expect(mockUpserts).toEqual([]);
  });

  it('answers a name the curated table lacks from data, not from a stale row', async () => {
    // Verona has its own airport 10 km away. A row saying otherwise is
    // exactly the shape of the four above.
    mockCache.verona = { iata_code: 'FCO', country: 'IT' };
    expect(await getIataCode('Verona')).toBe('VRN');
    expect(mockReads).toEqual([]);
  });

  it('honours a qualifier: Moscow, Idaho is Pullman, 9 km away', async () => {
    expect(await getIataCode('Moscow, Idaho')).toBe('PUW');
    // Bare Moscow is still the curated metro code.
    expect(await getIataCode('Moscow')).toBe('MOW');
  });

  it('does not answer a country with one airport, at home or abroad', async () => {
    // A country carries no population, so it loses on prominence to a town
    // that shares its name — Jamaica would have answered HAV, a town in Cuba —
    // and where it wins, its first airport is ranked from its centroid: Italy
    // would have answered PEG, Perugia. Neither is an answer.
    for (const [country, wrong] of [['Jamaica', 'HAV'], ['Italy', 'PEG'], ['Costa Rica', 'CUL']]) {
      let served: string | null;
      try {
        served = await getIataCode(country);
      } catch {
        served = null;
      }
      expect(served).not.toBe(wrong);
    }
    // ...but a trip can still name a reading that is not the country.
    expect(await getIataCode('Georgia', { tripDestinationNames: ['Atlanta', 'Savannah'] })).toBe('ATL');
  });

  it('takes the city over the region that shares its label', async () => {
    // San Juan's PROVINCE leads the resolver's raw order with Mendoza 145 km
    // away; the same preference the origin side applies picks the city's own.
    expect(await getIataCode('San Juan')).toBe('UAQ');
  });
});

describe('trip context reaches the resolver', () => {
  it('picks the reading the trip is near', async () => {
    // Bare Portland is Oregon, the more prominent reading. On a trip through
    // Boston it is Maine, 160 km away.
    expect(await getIataCode('Portland')).toBe('PDX');
    expect(await getIataCode('Portland', { tripDestinationNames: ['Boston'] })).toBe('PWM');
  });

  it('ignores the city itself among the trip names', async () => {
    expect(
      await getIataCode('Portland', { tripDestinationNames: ['Boston', 'Portland'] }),
    ).toBe('PWM');
  });

  it('will not fly a trip to a namesake 1,000 km from every stop', async () => {
    // With New York as the only other stop, the resolver's trip rule picks
    // Birmingham, Alabama: 1,400 km against England's 5,500 clears its ratio.
    // That is a question for an origin, and a wrong country for a price.
    expect(await getIataCode('Birmingham', { tripDestinationNames: ['New York'] })).toBe('BHX');
  });

  it('never lets context overturn a curated row', async () => {
    // Paris, Texas is 2,100 km from New York and Rome, Georgia 100 km from
    // Atlanta. The curated rows stand.
    expect(await getIataCode('Paris', { tripDestinationNames: ['New York'] })).toBe('PAR');
    expect(await getIataCode('Rome', { tripDestinationNames: ['Atlanta'] })).toBe('ROM');
  });
});

describe('a Duffel suggestion must be where the artifact says the name is', () => {
  it('accepts and caches a suggestion near the trip, skipping one that is not', async () => {
    // `Wengen` is not in the artifact (pop. ~1,000, no airport). Duffel's
    // first hit is in Malaysia; its second is Zurich.
    suggest(DUFFEL.JHB, DUFFEL.ZRH);
    expect(await getIataCode('Wengen', { tripDestinationNames: ['Zurich', 'Bern'] })).toBe('ZRH');
    expect(mockUpserts).toEqual([{ city_name: 'wengen', iata_code: 'ZRH', country: 'CH' }]);
  });

  it('refuses, and caches nothing, when every suggestion is elsewhere', async () => {
    suggest(DUFFEL.JHB);
    await expect(
      getIataCode('Wengen', { tripDestinationNames: ['Zurich', 'Bern'] }),
    ).rejects.toThrow('No IATA code found');
    expect(mockUpserts).toEqual([]);
  });

  it('skips a cached row the trip contradicts, and overwrites it once verified', async () => {
    mockCache.wengen = { iata_code: 'JHB', country: 'MY' };
    suggest(DUFFEL.ZRH);
    expect(await getIataCode('Wengen', { tripDestinationNames: ['Zurich'] })).toBe('ZRH');
    expect(mockReads).toEqual(['wengen']);
    expect(mockUpserts).toEqual([{ city_name: 'wengen', iata_code: 'ZRH', country: 'CH' }]);
  });

  it('refuses Montevideo for Monteverde on a Costa Rica trip, cached or fresh', async () => {
    // The production row, with the trip that exposes it: Montevideo is
    // 5,600 km from La Fortuna.
    mockCache.monteverde = { iata_code: 'MVD', country: 'UY' };
    suggest(DUFFEL.MVD);
    const context = { tripDestinationNames: ['La Fortuna', 'Manuel Antonio'] };
    let served: string | null = null;
    try {
      served = await getIataCode('Monteverde', context);
    } catch {
      served = null;
    }
    expect(served).not.toBe('MVD');
    expect(mockUpserts).toEqual([]);
  });

  it('holds a place with no airport of its own to its own country and a 2-hour drive', async () => {
    // Bothaville, South Africa (pop. 71,934) is in the artifact with no
    // scheduled airport in range, so it is evidence about itself.
    suggest(
      // 75 km away but across a border: refused on country.
      { type: 'airport', iata_code: 'XLS', iata_country_code: 'LS', name: 'Border Field', city_name: 'Elsewhere', latitude: -27.9, longitude: 27.1 },
      // Welkom, 68 km away, same country: accepted.
      { type: 'airport', iata_code: 'WEL', iata_country_code: 'ZA', name: 'Welkom Airport', city_name: 'Welkom', latitude: -27.998, longitude: 26.669 },
    );
    expect(await getIataCode('Bothaville')).toBe('WEL');
    expect(mockUpserts).toEqual([{ city_name: 'bothaville', iata_code: 'WEL', country: 'ZA' }]);
  });

  it('with no evidence at all, serves only a suggestion named as asked — uncached', async () => {
    suggest(DUFFEL.LHR);
    expect(await getIataCode('Heathrow')).toBe('LHR');
    // Served for this call, never written: an unchecked guess must not
    // become permanent.
    expect(mockUpserts).toEqual([]);

    suggest(DUFFEL.JHB);
    await expect(getIataCode('Zzyzx')).rejects.toThrow('No IATA code found');
    expect(mockUpserts).toEqual([]);
  });

  it('still serves a cached row when there is nothing to check it against', async () => {
    // Unchanged behaviour for a name nothing knows: the row is all there is.
    mockCache.zzyzx = { iata_code: 'LAS', country: 'US' };
    expect(await getIataCode('Zzyzx')).toBe('LAS');
  });
});

describe('POST /api/flights/iata', () => {
  // Assembled the way src/index.ts mounts it, so the schema is exercised.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const flights = require('../routes/flights').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { errorHandler } = require('../middleware/error');
  const app = express();
  app.use(express.json());
  app.use('/api/flights', flights);
  app.use(errorHandler);

  it('passes the trip through to the lookup when the caller sends one', async () => {
    const bare = await request(app).post('/api/flights/iata').send({ cityName: 'Portland' });
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ cityName: 'Portland', iataCode: 'PDX' });

    const onTrip = await request(app)
      .post('/api/flights/iata')
      .send({ cityName: 'Portland', tripDestinationNames: ['Boston'] });
    expect(onTrip.body.iataCode).toBe('PWM');
  });

  it('bounds the trip the way /api/locations/resolve does', async () => {
    const tooMany = Array.from({ length: 13 }, (_, i) => `City ${i}`);
    const res = await request(app)
      .post('/api/flights/iata')
      .send({ cityName: 'Portland', tripDestinationNames: tooMany });
    expect(res.status).toBe(400);
  });
});

describe('the name check refuses every measured near-miss', () => {
  it.each([
    ['Siena', ['Senai International Airport', 'Johor Bahru']],
    ['Sintra', ['Tebelian Airport', 'Sintang']],
    ['Bath', ['Bathpalathang Airport', 'Jakar']],
    ['Monteverde', ['Carrasco International Airport', 'Montevideo']],
  ])('%s is not %s', (query, names) => {
    expect(namedAsAsked(query, { iataCode: 'XXX', country: null, lat: null, lon: null, names })).toBe(false);
  });

  it.each([
    ['Heathrow', ['Heathrow Airport', 'London']],
    ['Flåm', ['Flam']],
    ['lake tahoe', ['Lake Tahoe Airport', 'South Lake Tahoe']],
  ])('%s is %s', (query, names) => {
    expect(namedAsAsked(query, { iataCode: 'XXX', country: null, lat: null, lon: null, names })).toBe(true);
  });
});
