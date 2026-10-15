jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

jest.mock('../services/supabase', () => {
  // Rows handed to .insert() are recorded so tests can assert on what
  // actually gets written to leg_price_cache.
  const insertedRows: any[] = [];
  const createChain = (): any => {
    const chain: any = {};
    const methods = [
      'select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order',
      // compareLeg now prunes superseded cache rows after a successful
      // insert, so the chain has to answer delete/in/lt too.
      'delete', 'in', 'lt',
    ];
    for (const m of methods) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.insert = jest.fn((rows: any[]) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ data: null });
    });
    // The cache write is an upsert (007 made the leg key unique); record the
    // same way so assertions about what gets persisted still see the rows.
    chain.upsert = jest.fn((rows: any[]) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ data: null });
    });
    // Make limit resolve like a promise too
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return {
    getSupabase: () => ({
      from: () => createChain(),
    }),
    __insertedRows: insertedRows,
  };
});

jest.mock('../services/flights', () => ({
  searchFlights: jest.fn(),
  getIataCode: jest.fn().mockResolvedValue('FCO'),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn(),
}));

import { compareLeg } from '../services/compareLeg';
const { searchFlights } = require('../services/flights');
const { searchTrains } = require('../services/trains');
const { __insertedRows: insertedRows } = require('../services/supabase');

describe('compareLeg', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adds 180 minutes airport overhead to flight duration', async () => {
    searchFlights.mockResolvedValue([
      {
        id: 'f1',
        price: 100,
        durationMinutes: 120,
        carrier: 'Lufthansa',
        carrierCode: 'LH',
        departure: '',
        arrival: '',
        currency: 'USD',
        stops: 0,
        bookingUrl: '',
        raw: {},
      },
    ]);
    searchTrains.mockResolvedValue([
      {
        id: 't1',
        price: 80,
        durationMinutes: 240,
        operator: 'DB',
        trainType: 'ICE',
        departure: '',
        arrival: '',
        currency: 'EUR',
        bookingUrl: '',
        limitedCoverage: false,
      },
    ]);

    const result = await compareLeg({
      origin: 'Rome',
      destination: 'Florence',
      date: '2026-06-01',
      travelers: 1,
    });

    // Flight: 120 + 180 = 300 min door-to-door vs Train: 240 min
    expect(result.fastest).toBe('train');
    // Train is cheaper ($80 vs $100)
    expect(result.cheapest).toBe('train');
    expect(result.recommendation).toBe('train');
  });

  it('recommends cheapest when price diff > 10%', async () => {
    searchFlights.mockResolvedValue([
      { id: 'f1', price: 50, durationMinutes: 90, carrier: 'A', carrierCode: 'A', departure: '', arrival: '', currency: 'USD', stops: 0, bookingUrl: '', raw: {} },
    ]);
    searchTrains.mockResolvedValue([
      { id: 't1', price: 100, durationMinutes: 180, operator: 'B', trainType: 'IC', departure: '', arrival: '', currency: 'EUR', bookingUrl: '', limitedCoverage: false },
    ]);

    const result = await compareLeg({
      origin: 'A',
      destination: 'B',
      date: '2026-06-01',
      travelers: 1,
    });

    // Flight is much cheaper
    expect(result.cheapest).toBe('flight');
    expect(result.recommendation).toBe('flight');
  });

  it('within 10% price — fastest wins', async () => {
    searchFlights.mockResolvedValue([
      { id: 'f1', price: 100, durationMinutes: 60, carrier: 'A', carrierCode: 'A', departure: '', arrival: '', currency: 'USD', stops: 0, bookingUrl: '', raw: {} },
    ]);
    searchTrains.mockResolvedValue([
      { id: 't1', price: 95, durationMinutes: 120, operator: 'B', trainType: 'IC', departure: '', arrival: '', currency: 'EUR', bookingUrl: '', limitedCoverage: false },
    ]);

    const result = await compareLeg({
      origin: 'A',
      destination: 'B',
      date: '2026-06-01',
      travelers: 1,
    });

    // Price diff ~5%, so fastest wins
    // Train is cheaper but flight + overhead = 60+180=240 vs train 120
    // Train is faster, and within 10% price diff
    expect(result.recommendation).toBe('train');
  });

  it('prefers flight when train has limitedCoverage', async () => {
    searchFlights.mockResolvedValue([
      { id: 'f1', price: 120, durationMinutes: 90, carrier: 'A', carrierCode: 'A', departure: '', arrival: '', currency: 'USD', stops: 0, bookingUrl: '', raw: {} },
    ]);
    searchTrains.mockResolvedValue([
      { id: 't1', price: 80, durationMinutes: 180, operator: 'B', trainType: 'IC', departure: '', arrival: '', currency: 'EUR', bookingUrl: '', limitedCoverage: true },
    ]);

    const result = await compareLeg({
      origin: 'Paris',
      destination: 'Barcelona',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(result.recommendation).toBe('flight');
  });

  it('refuses to let a bogus flight duration win the speed tiebreak', async () => {
    // -720 is what NRT→HNL produced when local-time timestamps were
    // subtracted across the date line. -720 + 180 overhead = -540 "minutes"
    // door-to-door beat every train and took the within-10% price tiebreak.
    searchFlights.mockResolvedValue([
      { id: 'f1', price: 100, durationMinutes: -720, carrier: 'A', carrierCode: 'A', departure: '', arrival: '', currency: 'USD', stops: 0, bookingUrl: '', raw: {} },
    ]);
    searchTrains.mockResolvedValue([
      { id: 't1', price: 95, durationMinutes: 120, operator: 'B', trainType: 'IC', departure: '', arrival: '', currency: 'EUR', bookingUrl: '', limitedCoverage: false },
    ]);

    const result = await compareLeg({
      origin: 'A',
      destination: 'B',
      date: '2026-06-01',
      travelers: 1,
    });

    // Can't compare on time, so no "fastest" claim and the tiebreak is a
    // no-op — the cheaper option (the train, at $95) stands.
    expect(result.fastest).toBe('unavailable');
    expect(result.cheapest).toBe('train');
    expect(result.recommendation).toBe('train');
    expect(result.timeDifference).toBe(0);
  });

  it('never persists a non-positive duration to leg_price_cache', async () => {
    insertedRows.length = 0;

    searchFlights.mockResolvedValue([
      { id: 'f1', price: 100, durationMinutes: -720, carrier: 'A', carrierCode: 'A', departure: '', arrival: '', currency: 'USD', stops: 0, bookingUrl: '', raw: {} },
    ]);
    searchTrains.mockResolvedValue([]);

    await compareLeg({
      origin: 'A',
      destination: 'B',
      date: '2026-06-01',
      travelers: 1,
    });

    const flightRow = insertedRows.find((r: any) => r.mode === 'flight');
    expect(flightRow).toBeDefined();
    // The row is still cached for its price; only the duration is withheld.
    expect(flightRow.price).toBe(100);
    expect(flightRow.duration_minutes).toBeNull();
  });

  it('returns unavailable when both are unavailable', async () => {
    searchFlights.mockRejectedValue(new Error('Duffel down'));
    searchTrains.mockResolvedValue([]);

    const result = await compareLeg({
      origin: 'A',
      destination: 'B',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(result.cheapest).toBe('unavailable');
    expect(result.fastest).toBe('unavailable');
    expect(result.recommendation).toBe('unavailable');
  });
});
