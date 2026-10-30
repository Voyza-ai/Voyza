/**
 * F1 — the saved-trip list dates a trip from the day it leaves home.
 *
 * GET /api/trips built `date_range.start` from the first city's arrival. Since
 * the optimizer starts the first stay on the day an overnight outbound LANDS
 * (JFK 19:25 Jan 10 → Paris 12:10 Jan 11: Paris from Jan 11), the history
 * page said the owner's Jan 10 – 17 trip started on Jan 11.
 */
jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
}));

let db: Record<string, any[]> = {};

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'not', 'order', 'limit', 'is']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.then = (res: any, rej: any) =>
        Promise.resolve({ data: db[table] ?? [], error: null }).then(res, rej);
      return chain;
    },
  }),
}));

import express from 'express';
import request from 'supertest';
import tripsRouter from '../routes/trips';
import { errorHandler } from '../middleware/error';

const app = express();
app.use(express.json());
app.use((req: any, _r, next) => {
  req.user = { id: 'owner' };
  next();
});
app.use('/api/trips', tripsRouter);
app.use(errorHandler);

/** The owner's trip as saved: Paris from the landing day, Jan 11. */
const ownerCities = [
  { trip_id: 't1', name: 'Paris', arrival_date: '2027-01-11', departure_date: '2027-01-13' },
  { trip_id: 't1', name: 'Zurich', arrival_date: '2027-01-13', departure_date: '2027-01-15' },
  { trip_id: 't1', name: 'London', arrival_date: '2027-01-15', departure_date: '2027-01-17' },
];

const tripRow = (outbound_leg: any) => ({
  id: 't1',
  title: 'Paris → Zurich → London',
  status: 'active',
  travelers: 6,
  total_cost: 5215,
  savings_vs_alternative: 0,
  created_at: '2026-10-30T00:00:00Z',
  is_public: false,
  outbound_leg,
});

const listed = async () => {
  const res = await request(app).get('/api/trips');
  expect(res.status).toBe(200);
  return res.body.trips[0];
};

beforeEach(() => {
  db = { group_members: [], cities: ownerCities };
});

describe('GET /api/trips — date_range', () => {
  it('starts on the day the overnight outbound leaves home', async () => {
    db.trips = [tripRow({ departDate: '2027-01-10', arriveDate: '2027-01-11', departTime: '19:25' })];
    const trip = await listed();
    // Before: { start: '2027-01-11', ... }.
    expect(trip.date_range).toEqual({ start: '2027-01-10', end: '2027-01-17' });
    // The flight is read to date the trip, not sent with the list.
    expect(trip).not.toHaveProperty('outbound_leg');
  });

  it('is unchanged for a same-day outbound', async () => {
    db.cities = [{ ...ownerCities[0], arrival_date: '2027-01-10' }, ...ownerCities.slice(1)];
    db.trips = [tripRow({ departDate: '2027-01-10', arriveDate: '2027-01-10' })];
    expect((await listed()).date_range).toEqual({ start: '2027-01-10', end: '2027-01-17' });
  });

  it('behaves exactly as before with no (or an unusable) outbound leg', async () => {
    for (const leg of [null, undefined, {}, { departDate: 'Jan 10' }, { departDate: '2027-01-12' }]) {
      db.trips = [tripRow(leg)];
      expect((await listed()).date_range).toEqual({ start: '2027-01-11', end: '2027-01-17' });
    }
  });

  it('has no date_range for a trip with no cities, as before', async () => {
    db.cities = [];
    db.trips = [tripRow({ departDate: '2027-01-10' })];
    expect((await listed()).date_range).toBeUndefined();
  });
});
