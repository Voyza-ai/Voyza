/**
 * POST /api/optimize/prewarm (prototype, exp/optimizer-speed): checked by the
 * optimize request's own schema, answers 202 at once, and leaves the
 * searches running (optimizer.ts prewarmHomeFlights).
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    FRONTEND_URL: 'http://localhost:3000',
    API_PUBLIC_URL: 'http://localhost:4000',
    CORS_ORIGIN: 'http://localhost:3000',
  },
}));

let release: () => void = () => {};
jest.mock('../services/optimizer', () => ({
  optimize: jest.fn(async () => ({ ok: true })),
  // Never settles on its own: the route must not wait for it.
  prewarmHomeFlights: jest.fn(() => new Promise((resolve) => (release = () => resolve({ searches: 0, deduped: false })))),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes';
import { errorHandler } from '../middleware/error';
import { prewarmHomeFlights } from '../services/optimizer';
import { addDays, todayIso } from '../utils/dates';

const mockedPrewarm = prewarmHomeFlights as jest.Mock;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return app;
}

const body = (over: Record<string, unknown> = {}) => ({
  cities: [{ name: 'Paris' }, { name: 'Amsterdam' }, { name: 'Berlin' }],
  startDate: addDays(todayIso(), 30),
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK', 'EWR', 'LGA'],
  returnToHome: true,
  totalNights: 7,
  ...over,
});

afterEach(() => {
  release();
  jest.clearAllMocks();
});

describe('POST /api/optimize/prewarm', () => {
  it('answers 202 at once and passes the trip as optimize would get it', async () => {
    const res = await request(makeApp()).post('/api/optimize/prewarm').send(body({ budget: 3000 }));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ prewarming: true });
    expect(mockedPrewarm).toHaveBeenCalledTimes(1);
    const arg = mockedPrewarm.mock.calls[0][0];
    expect(arg).toMatchObject({ travelers: 2, origin: 'New York', originAirports: ['JFK', 'EWR', 'LGA'], totalNights: 7 });
    expect(arg.cities).toEqual([{ name: 'Paris' }, { name: 'Amsterdam' }, { name: 'Berlin' }]);
    expect(arg).not.toHaveProperty('budget');
  });

  it('refuses what optimize would refuse, with the same sentence', async () => {
    const res = await request(makeApp())
      .post('/api/optimize/prewarm')
      .send(body({ cities: [{ name: 'Paris' }, { name: 'paris' }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Paris appears twice/);
    expect(mockedPrewarm).not.toHaveBeenCalled();
  });

  it('more destinations than the planner can send (30): refused, nothing searched', async () => {
    const cities = Array.from({ length: 31 }, (_, i) => ({ name: `City ${i + 1}` }));
    const res = await request(makeApp()).post('/api/optimize/prewarm').send(body({ cities, totalNights: 62 }));
    expect(res.status).toBe(400);
    expect(mockedPrewarm).not.toHaveBeenCalled();
    const ok = await request(makeApp()).post('/api/optimize/prewarm').send(body({ cities: cities.slice(0, 30), totalNights: 60 }));
    expect(ok.status).toBe(202);
  });

  it('no home city: nothing to pre-search', async () => {
    const { origin: _o, originAirports: _a, ...rest } = body();
    const res = await request(makeApp()).post('/api/optimize/prewarm').send(rest);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ prewarming: false });
    expect(mockedPrewarm).not.toHaveBeenCalled();
  });
});
