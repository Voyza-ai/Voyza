import express from 'express';
import request from 'supertest';

jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', FRONTEND_URL: 'http://localhost:3000' },
}));

const TRIP = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

// Per-test table contents.
const db: { session: any; trip: any; cities: any[]; transports: any[] } = {
  session: null,
  trip: null,
  cities: [],
  transports: [],
};

jest.mock('../services/supabase', () => {
  const chain = (rows: () => any, list = false) => {
    const c: any = {
      select: () => c,
      eq: () => c,
      order: () => (list ? Promise.resolve({ data: rows() }) : c),
      limit: () => c,
      single: () => Promise.resolve({ data: rows() }),
      then: (ok: any, bad: any) => Promise.resolve({ data: rows() }).then(ok, bad),
    };
    return c;
  };
  return {
    getSupabase: () => ({
      from: (table: string) => {
        if (table === 'canvas_sessions') return chain(() => db.session);
        if (table === 'trips') return chain(() => db.trip);
        if (table === 'cities') return chain(() => db.cities, true);
        if (table === 'transports') return chain(() => db.transports);
        throw new Error(`unexpected table ${table}`);
      },
    }),
  };
});

import shared from '../routes/shared';
import { errorHandler } from '../middleware/error';

const app = express();
app.use('/api/shared', shared);
app.use(errorHandler);

beforeEach(() => {
  db.session = { share_token: TOKEN, share_mode: 'view' };
  db.trip = { id: TRIP, title: 'Rome → Venice', status: 'active', user_id: 'owner-user-id', travelers: 2 };
  db.cities = [
    { id: 'c1', trip_id: TRIP, name: 'Rome', position: 0, arrival_date: '2027-04-11', departure_date: '2027-04-14', hotels: [] },
    { id: 'c2', trip_id: TRIP, name: 'Venice', position: 1, arrival_date: '2027-04-14', departure_date: '2027-04-16', hotels: [] },
  ];
  db.transports = [];
});

describe('GET /api/shared/:tripId (view-only link, no account)', () => {
  it('returns the trip for the current view-only link, without the owner', async () => {
    const res = await request(app).get(`/api/shared/${TRIP}?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.trip.title).toBe('Rome → Venice');
    expect(res.body.trip.cities.map((c: any) => c.name)).toEqual(['Rome', 'Venice']);
    expect(res.body.trip).not.toHaveProperty('ownerId');
    expect(JSON.stringify(res.body)).not.toContain('owner-user-id');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a link in suggest or edit mode (those need an account)', async () => {
    for (const mode of ['suggest', 'edit']) {
      db.session = { share_token: TOKEN, share_mode: mode };
      const res = await request(app).get(`/api/shared/${TRIP}?token=${TOKEN}`);
      expect(res.status).toBe(404);
    }
  });

  it('refuses a reset (old) token and a missing or malformed one', async () => {
    expect((await request(app).get(`/api/shared/${TRIP}?token=${OTHER}`)).status).toBe(404);
    expect((await request(app).get(`/api/shared/${TRIP}`)).status).toBe(404);
    expect((await request(app).get(`/api/shared/${TRIP}?token=nope`)).status).toBe(404);
    expect((await request(app).get(`/api/shared/not-a-uuid?token=${TOKEN}`)).status).toBe(404);
  });

  it('refuses a trip with no share link yet, and an archived trip', async () => {
    db.session = null;
    expect((await request(app).get(`/api/shared/${TRIP}?token=${TOKEN}`)).status).toBe(404);
    db.session = { share_token: TOKEN, share_mode: 'view' };
    db.trip = { ...db.trip, status: 'archived' };
    expect((await request(app).get(`/api/shared/${TRIP}?token=${TOKEN}`)).status).toBe(404);
  });

  it('gives every refusal the same message', async () => {
    db.session = { share_token: TOKEN, share_mode: 'edit' };
    const a = await request(app).get(`/api/shared/${TRIP}?token=${TOKEN}`);
    db.session = { share_token: TOKEN, share_mode: 'view' };
    const b = await request(app).get(`/api/shared/${TRIP}?token=${OTHER}`);
    expect(a.body).toEqual(b.body);
  });
});
