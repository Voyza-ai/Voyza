/**
 * POST /api/flights/home-legs (presets) with trip context: the route's two
 * trip ends decide which "Lagos" the home flight is for. Real router, real
 * buildHomeLeg -> getIataCode -> location artifact; Duffel/Supabase mocked.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

// Every read misses, every write succeeds.
jest.mock('../services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'insert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.upsert = jest.fn().mockResolvedValue({ data: null, error: null });
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
});

jest.mock('../services/currency', () => ({
  convertToUsd: jest.fn(async (amount: number) => amount),
}));

// Fares by IATA pair; anything unlisted is $100. `asked` records every search.
const mockAsked: string[] = [];
const mockFares: Record<string, number> = {};
jest.mock('../services/duffel', () => ({
  getDuffel: () => ({
    offerRequests: {
      create: jest.fn(async (body: any) => {
        const s = body.slices[0];
        mockAsked.push(`${s.origin}>${s.destination}`);
        const price = mockFares[`${s.origin}>${s.destination}`] ?? 100;
        return {
          data: {
            offers: [
              {
                id: `o-${s.origin}-${s.destination}-${s.departure_date}`,
                total_amount: String(price),
                total_currency: 'USD',
                slices: [
                  {
                    duration: 'PT2H',
                    segments: [
                      {
                        departing_at: `${s.departure_date}T09:00:00`,
                        arriving_at: `${s.departure_date}T11:00:00`,
                        origin: { time_zone: 'Europe/London' },
                        destination: { time_zone: 'Europe/Lisbon' },
                        operating_carrier: { name: 'Test Air', iata_code: 'TA' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }),
    },
    // Nothing here should need Duffel's fuzzy place search.
    suggestions: { list: jest.fn(async () => ({ data: [] })) },
  }),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import express from 'express';
import request from 'supertest';
import flights from '../routes/flights';
import { errorHandler } from '../middleware/error';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/flights', flights);
  app.use(errorHandler);
  return app;
}

const touches = (code: string) => mockAsked.filter((k) => k.split('>').includes(code));

beforeEach(() => {
  mockAsked.length = 0;
});

describe('POST /api/flights/home-legs - trip context', () => {
  it('flies home from FAO when a Portugal trip ends in Lagos', async () => {
    const res = await request(makeApp()).post('/api/flights/home-legs').send({
      originAirports: ['LHR'],
      originCity: 'London',
      firstCity: 'Lisbon',
      lastCity: 'Lagos',
      startDate: '2030-07-01',
      endDate: '2030-07-08',
      travelers: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.outboundLeg.destAirport).toBe('LIS');
    expect(res.body.returnLeg.originAirport).toBe('FAO');
    expect(touches('LOS')).toEqual([]);
  });

  it('still answers LOS for a trip that is only Lagos', async () => {
    const res = await request(makeApp()).post('/api/flights/home-legs').send({
      originAirports: ['LHR'],
      firstCity: 'Lagos',
      lastCity: 'Lagos',
      startDate: '2030-07-10',
      endDate: '2030-07-15',
      travelers: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.outboundLeg.destAirport).toBe('LOS');
    expect(touches('FAO')).toEqual([]);
  });
});
