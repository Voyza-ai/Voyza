/**
 * POST /api/optimize input validation (B11-B13), over the real router.
 *
 * Each of these used to be accepted and quietly produce a broken trip:
 *   B11  fewer nights than cities  → a 0-night city (checkin === checkout)
 *   B12  the same city twice       → `dates` keyed by name, second stay
 *                                    overwrote the first
 *   B13  a start date in the past  → every leg priced for "tomorrow" while
 *                                    the trip's own dates stayed in the past
 * Now each is a 400. Its `error` is one sentence the traveller can act on —
 * lib/api.ts apiFetch throws ApiError(status, body.error), so this is the text
 * the planner shows — and `details` keeps zod's field-level messages.
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

/**
 * The `error` a traveller reads. It used to be the literal 'ValidationError'
 * for every one of these, which the planner turned into "I couldn't make sense
 * of one of your answers. Try rephrasing the dates or budget?" — for a trip
 * whose only problem was visiting Paris twice. Each reachable 400 now says
 * what is wrong and what to do instead, in one sentence; status and shape
 * (`error` + `details`) are unchanged.
 */
describe('POST /api/optimize — every 400 says what to do, in one sentence', () => {
  const post = (over: Record<string, unknown>) => request(makeApp()).post('/api/optimize').send(body(over));

  const oneSentence = (text: string) => {
    expect(typeof text).toBe('string');
    expect(text).not.toBe('ValidationError');
    // Never trips the planner's generic "validation"/"fetch" rewrites.
    expect(text.toLowerCase()).not.toMatch(/validation|fetch/);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text.slice(0, -1)).not.toMatch(/[.!?]\s/);
  };

  it('a city visited twice names the city and how to get more time there', async () => {
    const res = await post({ cities: [{ name: 'Paris' }, { name: 'Rome' }, { name: 'Paris' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Paris appears twice in your trip — to spend more time there, add nights to your first Paris stay instead of returning to it.',
    );
    oneSentence(res.body.error);
    expect(res.body.details.cities).toEqual(['Each city can appear only once']);
  });

  it('names the city as the traveller first typed it, whatever the repeat’s case or spacing', async () => {
    const res = await post({ cities: ['Paris', 'Rome', ' paris '] });
    expect(res.body.error).toMatch(/^Paris appears twice in your trip/);
  });

  it('a start date in the past says which date and what to pick', async () => {
    const res = await post({ startDate: '2026-01-05' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Your start date (Jan 5, 2026) has already passed — pick today or a later date.');
    oneSentence(res.body.error);
  });

  it('fewer nights than cities says how many of each', async () => {
    const res = await post({ totalNights: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Your 2-night trip has 3 cities — each city needs at least one night, so add nights or remove a city.',
    );
    oneSentence(res.body.error);
  });

  it('more than 180 nights', async () => {
    const res = await post({ totalNights: 200 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Trips can be at most 180 nights — choose a shorter date range.');
  });

  it('no destinations', async () => {
    const res = await post({ cities: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Add at least one destination to plan a trip.');
  });

  it('one city and no home city: a 400 that says what is missing, not a 500', async () => {
    const res = await post({ cities: [{ name: 'Reykjavik' }], origin: undefined, originAirports: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Tell us where you are starting from, or add a second city, so there is a journey to plan.',
    );
    oneSentence(res.body.error);
    expect(mockedOptimize).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing start date', { startDate: '' }, 'Choose a start date for your trip.'],
    ['zero travelers', { travelers: 0 }, 'A trip needs at least one traveler.'],
    ['a zero budget', { budget: 0 }, 'Set a budget above $0, or skip the budget question.'],
    [
      'a blank destination',
      { cities: [{ name: 'Paris' }, { name: '' }] },
      'One of your destinations is blank — enter a city name for each stop.',
    ],
  ])('%s', async (_label, over, sentence) => {
    const res = await post(over);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(sentence);
    oneSentence(res.body.error);
    expect(res.body).toHaveProperty('details');
  });

  it('anything else still gets a sentence, never a field dump', async () => {
    const res = await post({ originAirports: ['J'] });
    expect(res.status).toBe(400);
    oneSentence(res.body.error);
  });
});
