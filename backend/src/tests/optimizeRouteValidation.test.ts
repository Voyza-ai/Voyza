/**
 * POST /api/optimize input validation (B11-B13), over the real router.
 *
 * Each of these used to be accepted and quietly produce a broken trip:
 *   B11  fewer nights than cities  → a 0-night city (checkin === checkout)
 *   B12  the same city twice       → `dates` keyed by name, second stay
 *                                    overwrote the first
 *   B13  a start date in the past  → every leg priced for "tomorrow" while
 *                                    the trip's own dates stayed in the past
 * Now each is a 400 'ValidationError'. The planner already renders that:
 * lib/api.ts apiFetch throws ApiError(400, 'ValidationError') and
 * PlanningChat's runOptimizeAndBuild catch shows its existing message.
 *
 * optimize() itself is mocked — this file is only about what reaches it.
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

jest.mock('../services/optimizer', () => ({
  optimize: jest.fn(async () => ({ ok: true })),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes';
import { errorHandler } from '../middleware/error';
import { optimize } from '../services/optimizer';
import { addDays, todayIso } from '../utils/dates';

const mockedOptimize = optimize as jest.Mock;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return app;
}

const future = addDays(todayIso(), 30);
const body = (over: Record<string, unknown> = {}) => ({
  cities: [{ name: 'Paris' }, { name: 'Rome' }, { name: 'Venice' }],
  startDate: future,
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  totalNights: 7,
  ...over,
});

beforeEach(() => mockedOptimize.mockClear());

describe('POST /api/optimize — validation', () => {
  it('accepts a normal trip', async () => {
    const res = await request(makeApp()).post('/api/optimize').send(body());
    expect(res.status).toBe(200);
    expect(mockedOptimize).toHaveBeenCalledTimes(1);
  });

  it('B11: rejects fewer nights than cities', async () => {
    const res = await request(makeApp()).post('/api/optimize').send(body({ totalNights: 2 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(res.body.details.totalNights).toEqual(['Need at least one night per city']);
    expect(mockedOptimize).not.toHaveBeenCalled();
  });

  it('B11: still accepts exactly one night per city, and an omitted total', async () => {
    expect((await request(makeApp()).post('/api/optimize').send(body({ totalNights: 3 }))).status).toBe(200);
    expect(
      (await request(makeApp()).post('/api/optimize').send(body({ totalNights: undefined }))).status,
    ).toBe(200);
  });

  it.each([
    [[{ name: 'Paris' }, { name: 'Rome' }, { name: 'Paris' }]],
    [['Paris', 'Rome', ' paris ']],
  ])('B12: rejects a repeated city (%j)', async (cities) => {
    const res = await request(makeApp()).post('/api/optimize').send(body({ cities }));
    expect(res.status).toBe(400);
    expect(res.body.details.cities).toEqual(['Each city can appear only once']);
    expect(mockedOptimize).not.toHaveBeenCalled();
  });

  it('B13: rejects a start date in the past', async () => {
    const res = await request(makeApp())
      .post('/api/optimize')
      .send(body({ startDate: addDays(todayIso(), -3) }));
    expect(res.status).toBe(400);
    expect(res.body.details.startDate).toEqual(['Start date is in the past']);
    expect(mockedOptimize).not.toHaveBeenCalled();
  });

  it("B13: allows UTC-yesterday (it is still 'today' in the Americas) and today", async () => {
    for (const startDate of [addDays(todayIso(), -1), todayIso()]) {
      const res = await request(makeApp()).post('/api/optimize').send(body({ startDate }));
      expect(res.status).toBe(200);
    }
  });
});
