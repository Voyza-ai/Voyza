jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
}));

// Records every insert/update per table; reads come from `db`.
const inserts: Record<string, any[]> = {};
const updates: Array<{ table: string; patch: any }> = [];
let db: Record<string, any> = {};

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      let mode: 'read' | 'insert' | 'update' = 'read';
      let payload: any = null;
      let priorCopyLookup = false;
      const chain: any = {};
      for (const m of ['select', 'order', 'limit', 'ilike', 'is', 'neq']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.eq = jest.fn((col: string) => {
        if (col === 'cloned_from_trip_id') priorCopyLookup = true;
        return chain;
      });
      chain.insert = jest.fn((rows: any) => {
        mode = 'insert';
        payload = rows;
        (inserts[table] ??= []).push(rows);
        return chain;
      });
      chain.update = jest.fn((patch: any) => {
        mode = 'update';
        updates.push({ table, patch });
        return chain;
      });
      const result = () => {
        if (mode === 'insert') {
          if (table === 'trips') return { data: { id: 'new-trip', ...payload }, error: null };
          if (table === 'cities') {
            return {
              data: payload.map((c: any, i: number) => ({ ...c, id: `new-c${i}` })),
              error: null,
            };
          }
          return { data: null, error: null };
        }
        if (mode === 'update') return { data: null, error: null };
        if (table === 'trips' && priorCopyLookup) return { data: db.priorCopies ?? [], error: null };
        return { data: db[table] ?? null, error: null };
      };
      chain.single = jest.fn(() => Promise.resolve(result()));
      chain.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej);
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
  req.user = { id: 'cloner' };
  next();
});
app.use('/api/trips', tripsRouter);
app.use(errorHandler);

const sourceTrip = (over: any = {}) => ({
  id: 'src',
  user_id: 'owner',
  title: 'Italy',
  travelers: 1,
  total_cost: 1472,
  is_public: true,
  allow_clones: false,
  clone_count: 3,
  origin_city: 'New York',
  origin_airports: ['JFK', 'LGA', 'EWR'],
  return_to_home: true,
  outbound_leg: { price: 253 },
  return_leg: { price: 240 },
  return_city: null,
  return_airports: null,
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(inserts)) delete inserts[k];
  updates.length = 0;
  db = {
    trips: sourceTrip(),
    cities: [
      { id: 'c0', position: 0, name: 'Florence' },
      { id: 'c1', position: 1, name: 'Venice' },
    ],
    transports: [
      { from_city_id: 'c0', to_city_id: 'c1', mode: 'train', operator: 'Trenitalia', price: 24,
        duration_minutes: null, journey_time_minutes: 125 },
    ],
  };
});

describe('POST /api/trips/:id/clone — a faithful copy', () => {
  it("carries the original's home anchor, cost, and flights/trains", async () => {
    const res = await request(app).post('/api/trips/src/clone').send({});
    expect(res.status).toBe(201);

    const newTrip = inserts.trips[0];
    expect(newTrip.origin_city).toBe('New York');
    expect(newTrip.origin_airports).toEqual(['JFK', 'LGA', 'EWR']);
    expect(newTrip.outbound_leg).toEqual({ price: 253 });
    expect(newTrip.return_leg).toEqual({ price: 240 });
    expect(newTrip.total_cost).toBe(1472);

    // Transports copied by default, re-keyed to the NEW city ids, with
    // train duration fields intact.
    const [t] = inserts.transports[0];
    expect(t).toMatchObject({
      trip_id: 'new-trip',
      from_city_id: 'new-c0',
      to_city_id: 'new-c1',
      operator: 'Trenitalia',
      price: 24,
      journey_time_minutes: 125,
    });
  });

  it('defaults a source with no origin to New York (JFK), legs left for auto-search', async () => {
    db.trips = sourceTrip({ origin_city: null, origin_airports: null, outbound_leg: null, return_leg: null });
    await request(app).post('/api/trips/src/clone').send({});
    const newTrip = inserts.trips[0];
    expect(newTrip.origin_city).toBe('New York');
    expect(newTrip.origin_airports).toEqual(['JFK']);
    expect(newTrip.outbound_leg).toBeNull();
    expect(newTrip.return_leg).toBeNull();
  });

  it('a copy is always a round trip, even when the original was one-way', async () => {
    db.trips = sourceTrip({ return_to_home: false, return_leg: null });
    await request(app).post('/api/trips/src/clone').send({});
    expect(inserts.trips[0].return_to_home).toBe(true);
  });

  it('never writes a stale owner group_members row', async () => {
    await request(app).post('/api/trips/src/clone').send({});
    expect(inserts.group_members).toBeUndefined();
  });

  it("a user's FIRST clone of a trip bumps the count", async () => {
    await request(app).post('/api/trips/src/clone').send({});
    expect(updates).toContainEqual({ table: 'trips', patch: { clone_count: 4 } });
  });

  it('a repeat clone by the same user does NOT bump the count', async () => {
    db.priorCopies = [{ id: 'earlier-copy' }];
    const res = await request(app).post('/api/trips/src/clone').send({});
    expect(res.status).toBe(201); // the copy is still made
    expect(updates.some((u) => 'clone_count' in u.patch)).toBe(false);
  });

  it("the owner cloning their own trip never counts", async () => {
    db.trips = sourceTrip({ user_id: 'cloner' });
    const res = await request(app).post('/api/trips/src/clone').send({});
    expect(res.status).toBe(201);
    expect(updates.some((u) => 'clone_count' in u.patch)).toBe(false);
  });
});
