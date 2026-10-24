/**
 * `POST /api/locations/resolve`, over a real Express app.
 *
 * Typecheck cannot tell you a route is mounted, that its schema rejects what
 * it should, or that the general rate limiter is no longer counting it. Those
 * are the three things most likely to be wrong about a new endpoint and the
 * three a unit test of the handler would miss entirely, so this assembles the
 * router and drives HTTP through it.
 *
 * `config/env` is mocked with an explicit object rather than a spread of
 * `jest.requireActual`: loading the real module runs its zod parse and calls
 * `process.exit(1)` on a missing variable, which kills the worker instead of
 * failing the test.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    LOCATION_RESOLVER_MODE: 'shadow',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  },
}));

import express from 'express';
import request from 'supertest';

import locations from '../routes/locations';
import { errorHandler } from '../middleware/error';
import { apiLimiter, locationLimiter } from '../middleware/rateLimit';

/** The same assembly order as `src/index.ts`, limiters included. */
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiLimiter);
  app.use('/api/locations', locationLimiter);
  app.use('/api/locations', locations);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

/**
 * The FIRST request builds the resolver index — 36,009 places, about 1.1 s on
 * a quiet machine. Jest's default 5 s covers that with room to spare until the
 * machine is busy, and then the whole suite fails on a cold start rather than
 * on anything it is testing. Raised because this is a one-off construction
 * cost, not a budget: `locationPerf.test.ts` is where build time is actually
 * asserted, and it needs a quiet machine to mean anything.
 */
jest.setTimeout(45_000);

const post = (body: unknown) => request(app).post('/api/locations/resolve').send(body as object);

describe('answers', () => {
  it('resolves a place, with airports and a reason', async () => {
    const res = await post({ query: 'nyc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.place.name).toBe('New York City');
    expect(res.body.place.placeId).toBeTruthy();
    expect(res.body.airports[0].iata).toBe('JFK');
    expect(res.body.via).toBe('curated-alias');
  });

  it('asks, with candidates a UI can render', async () => {
    const res = await post({ query: 'Paris' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ambiguous');
    expect(res.body.reason).toBe('multi-country');
    expect(res.body.candidates.length).toBeGreaterThan(1);
    for (const candidate of res.body.candidates) {
      expect(candidate.placeId).toBeTruthy();
      expect(candidate.label).toMatch(/\w/);
      expect(candidate.airports.length).toBeGreaterThan(0);
    }
  });

  it('offers suggestions for a typo and never applies one', async () => {
    const res = await post({ query: 'pariss' });
    expect(res.body.status).toBe('unknown');
    expect(res.body.suggestions[0].name).toBe('Paris');
    expect(res.body.suggestions[0].editDistance).toBe(1);
  });

  it('uses the context it is given', async () => {
    const res = await post({
      query: 'Rome',
      tripDestinationNames: ['Florence', 'Venice'],
    });
    expect(res.body.status).toBe('resolved');
    expect(res.body.place.country).toBe('IT');
    expect(res.body.via).toBe('trip-context');
  });

  it('honours max', async () => {
    const res = await post({ query: 'New York', max: 1 });
    expect(res.body.airports).toHaveLength(1);
  });

  it('ships a trimmed shape, not the internal Place', async () => {
    // The browser must not depend on the artifact's layout, and an ambiguous
    // answer would otherwise carry eight full airport lists.
    const res = await post({ query: 'nyc' });
    expect(Object.keys(res.body.place).sort()).toEqual(
      ['admin', 'country', 'kind', 'lat', 'lon', 'name', 'placeId'].sort(),
    );
    expect(res.body.place).not.toHaveProperty('aliases');
    expect(res.body.place).not.toHaveProperty('curatedAliases');
    expect(res.body.place).not.toHaveProperty('airportRank');
  });
});

describe('input bounds', () => {
  it('rejects a missing or empty query', async () => {
    for (const body of [{}, { query: '' }, { query: 123 }]) {
      expect((await post(body)).status).toBeGreaterThanOrEqual(400);
    }
  });

  it('rejects an over-long query rather than resolving it', async () => {
    // A 10 kB "place name" is an attack, not a city. The resolver trims too,
    // but by then the memory is spent.
    expect((await post({ query: 'x'.repeat(10_000) })).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects coordinates that are not coordinates', async () => {
    const res = await post({ query: 'Paris', userLatLon: { lat: 999, lon: 0 } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bounds the trip-context list', async () => {
    const res = await post({
      query: 'Paris',
      tripDestinationNames: Array.from({ length: 50 }, () => 'Rome'),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('does not throw on a non-Latin query', async () => {
    const res = await post({ query: '東京' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.suggestions).toEqual([]);
  });
});

describe('rate limiting', () => {
  it('is covered where it can actually be observed', () => {
    // Not asserted here: the limiter's `skip` returns true for
    // `NODE_ENV === 'test'`, so nothing engages and no RateLimit-* headers
    // are set — any assertion in this file would pass while testing nothing.
    // `locationRateLimit.test.ts` runs the same middleware with
    // NODE_ENV='production' and proves the exclusion by exhausting the
    // general budget.
    expect(true).toBe(true);
  });
});
