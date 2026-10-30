/**
 * F4 — a trip built from /api/flights/home-legs (a Browse preset) gets the
 * optimizer's landing-date rule too.
 *
 * Integrated run, 2026-10-30: /browse → Paris Long Weekend → Save. The saved
 * trip had Paris Nov 29 → Dec 2 while its outbound (JFK 19:25 Nov 29) landed
 * Nov 30 12:10, and the hotel search checked in Nov 29 — the night on the
 * plane that B1 removed from planned trips. The preset path builds the trip
 * from the preset plus this route and never applied the rule.
 *
 * The route now answers `firstCityArrival` (from the optimizer's own
 * firstStayArrival) when the caller sends the first city's departure.
 * Real router and buildHomeLeg; Duffel/Supabase mocked.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

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

/** Outbound to Paris: the Icelandair overnight (19:25 → 12:10 next day), or same-day. */
let mockSameDay = false;
jest.mock('../services/duffel', () => ({
  getDuffel: () => ({
    offerRequests: {
      create: jest.fn(async (body: any) => {
        const s = body.slices[0];
        const day = s.departure_date as string;
        const next = new Date(`${day}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        const toParis = s.destination === 'PAR';
        const landing = toParis && !mockSameDay ? next.toISOString().slice(0, 10) : day;
        return {
          data: {
            offers: [
              {
                id: `o-${s.origin}-${s.destination}-${day}`,
                total_amount: '891.60',
                total_currency: 'USD',
                slices: [
                  {
                    duration: 'PT10H45M',
                    segments: [
                      {
                        departing_at: `${day}T${toParis && !mockSameDay ? '19:25' : '07:15'}:00`,
                        arriving_at: `${landing}T${toParis && !mockSameDay ? '12:10' : '19:40'}:00`,
                        origin: { time_zone: 'America/New_York' },
                        destination: { time_zone: 'Europe/Paris' },
                        operating_carrier: { name: 'Icelandair', iata_code: 'FI' },
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

const app = express();
app.use(express.json());
app.use('/api/flights', flights);
app.use(errorHandler);

/** The Paris Long Weekend save, as canvasHandoff sends it. */
const parisPreset = (over: Record<string, unknown> = {}) => ({
  originAirports: ['JFK'],
  originCity: 'New York',
  firstCity: 'Paris',
  lastCity: 'Paris',
  startDate: '2030-11-29',
  endDate: '2030-12-02',
  firstCityDeparture: '2030-12-02',
  travelers: 4,
  returnToHome: true,
  ...over,
});

beforeEach(() => {
  mockSameDay = false;
});

describe('POST /api/flights/home-legs — firstCityArrival', () => {
  it('starts the first stay the day the overnight outbound lands', async () => {
    const res = await request(app).post('/api/flights/home-legs').send(parisPreset());
    expect(res.status).toBe(200);
    expect(res.body.outboundLeg.departDate).toBe('2030-11-29');
    expect(res.body.outboundLeg.arriveDate).toBe('2030-11-30');
    // Before: no firstCityArrival; the preset kept Paris from Nov 29.
    expect(res.body.firstCityArrival).toBe('2030-11-30');
  });

  it('a same-day outbound keeps the start date', async () => {
    mockSameDay = true;
    // Another week: flights.ts caches a search by route and date.
    const res = await request(app)
      .post('/api/flights/home-legs')
      .send(parisPreset({ startDate: '2030-11-22', endDate: '2030-11-25', firstCityDeparture: '2030-11-25' }));
    expect(res.body.outboundLeg.arriveDate).toBe('2030-11-22');
    expect(res.body.firstCityArrival).toBe('2030-11-22');
  });

  it('keeps the first city at least one night (the optimizer’s clamp)', async () => {
    const res = await request(app)
      .post('/api/flights/home-legs')
      .send(parisPreset({ firstCityDeparture: '2030-11-30' }));
    expect(res.body.firstCityArrival).toBe('2030-11-29');
  });

  it('without the first city’s departure, the response is exactly as before', async () => {
    const { firstCityDeparture, ...old } = parisPreset();
    const res = await request(app).post('/api/flights/home-legs').send(old);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('firstCityArrival');
    expect(res.body.outboundLeg).not.toBeNull();
  });

  it('rejects a malformed departure date', async () => {
    const res = await request(app)
      .post('/api/flights/home-legs')
      .send(parisPreset({ firstCityDeparture: 'Dec 2' }));
    expect(res.status).toBe(400);
  });
});
