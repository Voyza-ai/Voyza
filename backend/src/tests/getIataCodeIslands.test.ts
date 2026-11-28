/**
 * Island-style names: "Grand Turk Island" failed the airport lookup though
 * "Grand Turk" answers GDT — neither the curated table nor the artifact holds
 * the name with "Island" on it, and Duffel's place search returns nothing.
 * getIataCode now retries the name with the island word stripped, against the
 * curated table and the artifact only (islandNames.ts), and refuses the
 * stripped name wherever its reading is somewhere else: a wrong airport is
 * worse than none.
 *
 * Duffel and Supabase are mocked (Duffel suggests nothing, the cache is
 * empty); the artifact is the real checked-in one.
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

const mockUpserts: Array<Record<string, unknown>> = [];

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
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
import { islandNameVariants } from '../services/location/islandNames';

const { __mockDuffel: mockDuffel } = require('../services/duffel');

beforeEach(() => {
  jest.clearAllMocks();
  mockUpserts.length = 0;
  mockDuffel.suggestions.list.mockResolvedValue({ data: [] });
});

jest.setTimeout(30_000);

const trip = (...names: string[]) => ({ tripDestinationNames: names });

describe('island names find their airport', () => {
  it.each([
    ['Grand Turk Island', {}, 'GDT'],
    ['Grand Turk Island', trip('Providenciales', 'Grand Turk Island'), 'GDT'],
    ['Mykonos Island', {}, 'JMK'],
    ['Santorini Island', {}, 'JTR'],
    ['Providenciales Island', trip('Cockburn Town', 'Providenciales Island'), 'PLS'],
    ['Ibiza Island', trip('Barcelona', 'Ibiza Island'), 'IBZ'],
    ['Isle of Islay', trip('Edinburgh', 'Isle of Islay'), 'ILY'],
  ])('%s %j -> %s, without asking Duffel', async (name, context, expected) => {
    await expect(getIataCode(name, context)).resolves.toBe(expected);
    expect(mockDuffel.suggestions.list).not.toHaveBeenCalled();
    expect(mockUpserts).toHaveLength(0);
  });

  it('names the artifact already knows with the island word are unchanged', async () => {
    await expect(getIataCode('Rhode Island')).resolves.toBe('PVD');
    await expect(getIataCode('Canary Islands')).resolves.toBe('LPA');
  });
});

describe('and fail cleanly rather than land somewhere wrong', () => {
  it.each([
    // No airport on Skye; "Skye" is nowhere in the artifact.
    ['Isle of Skye', {}],
    ['Isle of Skye', trip('Edinburgh', 'Inverness', 'Isle of Skye')],
    // Stripped, each is a famous town elsewhere, or a fuzzy alias of one.
    ['Hamilton Island', trip('Cairns', 'Hamilton Island')], // YHM, Ontario
    ['Vancouver Island', {}], // YVR, across the strait
    ['Stewart Island', {}], // CCC, Cuba
    ['Big Island', {}], // EDO, Biga, Turkey
    ['Dauphin Island', trip('Mobile', 'New Orleans', 'Dauphin Island')], // YDN, Manitoba
    ['Antigua Island', trip('St Lucia', 'Barbados', 'Antigua Island')], // GUA, Guatemala
    // No trip to check the reading against: not used.
    ['Dauphin Island', {}],
    ['Antigua Island', {}],
    ['Ibiza Island', {}],
  ])('%s %j -> no code', async (name, context) => {
    await expect(getIataCode(name, context)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('islandNameVariants', () => {
  it.each([
    ['Grand Turk Island', ['Grand Turk']],
    ['Cayman Islands', ['Cayman']],
    ['Isle of Skye', ['Skye']],
    ['Island of Hawaii', ['Hawaii']],
    ['Isla Mujeres', ['Mujeres']],
    ['Isla de Margarita', ['Margarita']],
    ['Paris', []],
    ['Island', []],
    ['Isleworth', []],
  ])('%s -> %j', (name, expected) => {
    expect(islandNameVariants(name)).toEqual(expected);
  });
});
