jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
}));

// Table-routed supabase mock that records every filter call.
const calls: Array<{ table: string; method: string; args: any[] }> = [];
let tables: Record<string, any[]> = {};
// trips is read twice: candidates (is_public) and recent clones
// (cloned_from_trip_id) — route the second read by its filter.
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const local: any[] = [];
      const chain: any = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'order', 'limit']) {
        chain[m] = jest.fn((...args: any[]) => {
          calls.push({ table, method: m, args });
          local.push({ method: m, args });
          return chain;
        });
      }
      chain.then = (resolve: any, reject: any) => {
        let data = tables[table] ?? [];
        if (table === 'trips' && local.some((c) => c.method === 'in' && c.args[0] === 'cloned_from_trip_id')) {
          data = tables.recentClones ?? [];
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return chain;
    },
  }),
}));

import express from 'express';
import request from 'supertest';
import tripsRouter from '../routes/trips';
import { errorHandler } from '../middleware/error';
import { filterAndRank, fetchPopularTrips, type PopularTrip } from '../services/popularTrips';

const trip = (over: Partial<PopularTrip>): PopularTrip => ({
  id: 't',
  title: 'Trip',
  travelers: 2,
  totalCost: 2000,
  startDate: null,
  cloneCount: 0,
  clonesThisWeek: 0,
  createdAt: '2026-09-01T00:00:00Z',
  cities: [{ name: 'Rome', country: 'Italy' }],
  tags: ['food'],
  ownerName: null,
  isMine: false,
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  tables = {};
});

describe('filterAndRank', () => {
  const a = trip({ id: 'a', cloneCount: 50, clonesThisWeek: 1, tags: ['history'], totalCost: 3000 });
  const b = trip({ id: 'b', cloneCount: 10, clonesThisWeek: 8, tags: ['food', 'beach'], totalCost: 900,
    cities: [{ name: 'Lisbon', country: 'Portugal' }] });
  const c = trip({ id: 'c', cloneCount: 30, clonesThisWeek: 0, tags: ['food'], totalCost: null });

  it('popular = all-time clone count', () => {
    expect(filterAndRank([b, c, a], {}).map((t) => t.id)).toEqual(['a', 'c', 'b']);
  });

  it('trending = clones this week, and drops trips with no recent activity', () => {
    expect(filterAndRank([a, b, c], { sort: 'trending' }).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('filters by vibe tag (case-insensitive)', () => {
    expect(filterAndRank([a, b, c], { vibe: 'FOOD' }).map((t) => t.id)).toEqual(['c', 'b']);
  });

  it('filters by max budget and excludes unpriced trips', () => {
    expect(filterAndRank([a, b, c], { maxBudget: 1000 }).map((t) => t.id)).toEqual(['b']);
  });

  it('filters by city (any match, case-insensitive)', () => {
    expect(filterAndRank([a, b, c], { cities: ['lisbon', 'Paris'] }).map((t) => t.id)).toEqual(['b']);
  });

  it('caps results at the limit', () => {
    expect(filterAndRank([a, b, c], { limit: 2 })).toHaveLength(2);
  });
});

describe('fetchPopularTrips', () => {
  it('only queries opted-in (is_public) trips — never allow_recommendations', async () => {
    tables.trips = [];
    await fetchPopularTrips({}, 'me');
    expect(calls).toContainEqual({ table: 'trips', method: 'eq', args: ['is_public', true] });
    expect(calls.some((c) => c.args[0] === 'allow_recommendations')).toBe(false);
  });

  it('builds tags, trending counts, owner names, and isMine', async () => {
    tables.trips = [
      { id: 't1', title: 'Italy', travelers: 2, total_cost: 1500, vibe: 'Food',
        start_date: null, clone_count: 4, created_at: '2026-09-01T00:00:00Z', user_id: 'me' },
    ];
    tables.cities = [
      { trip_id: 't1', name: 'Rome', country: 'Italy', vibes: ['history', 'food'], position: 0 },
    ];
    // u2 cloned twice (counts once), u3 once, and the owner ('me') once
    // (never counts) → 2 distinct people this week.
    tables.recentClones = [
      { cloned_from_trip_id: 't1', user_id: 'u2' },
      { cloned_from_trip_id: 't1', user_id: 'u2' },
      { cloned_from_trip_id: 't1', user_id: 'u3' },
      { cloned_from_trip_id: 't1', user_id: 'me' },
    ];
    tables.user_profiles = [{ id: 'me', full_name: 'Gohil T' }];

    const [t] = await fetchPopularTrips({}, 'me');
    expect(t.tags.sort()).toEqual(['food', 'history']);
    expect(t.clonesThisWeek).toBe(2);
    expect(t.cloneCount).toBe(4);
    expect(t.ownerName).toBe('Gohil T');
    expect(t.isMine).toBe(true);
    expect(t.cities).toEqual([{ name: 'Rome', country: 'Italy' }]);
  });
});

describe('GET /api/trips/popular', () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'me' };
    next();
  });
  app.use('/api/trips', tripsRouter);
  app.use(errorHandler);

  it('is routed to discovery, not treated as a trip id', async () => {
    tables.trips = [];
    const res = await request(app).get('/api/trips/popular?sort=trending&vibe=food');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trips: [] });
  });

  it('rejects invalid sort values', async () => {
    const res = await request(app).get('/api/trips/popular?sort=random');
    expect(res.status).toBe(400);
  });
});
