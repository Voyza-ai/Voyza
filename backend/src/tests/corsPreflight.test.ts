/**
 * CORS preflights must be cacheable.
 *
 * Every JSON POST the frontend makes is preflighted (content-type
 * application/json, plus Authorization when signed in). With no
 * Access-Control-Max-Age the browser keeps a preflight answer for 5 s, so
 * almost every API call paid a second round trip before the real one —
 * ~135 ms each, measured against production at 54fd844, where the header was
 * absent.
 *
 * Driven through the real app from src/index.ts, so helmet, cors and the rate
 * limiters run in their real order.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'production',
    PORT: 0,
    CORS_ORIGIN: 'https://bluemurr.com, http://localhost:3000',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  },
}));
jest.mock('../services/presets', () => ({
  ...jest.requireActual('../services/presets'),
  startPresetRefreshScheduler: jest.fn(() => () => {}),
  warmPresetChecks: jest.fn(),
}));
// The boot warm-up (location index, then the preset checks: ~2 s of CPU) is
// bootWarmup.test.ts's subject, not this file's, and no request here resolves
// a place.
jest.mock('../services/location/originAirports', () => ({
  ...jest.requireActual('../services/location/originAirports'),
  originIndex: jest.fn(),
}));
jest.mock('morgan', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import { once } from 'events';
import request from 'supertest';
import { server } from '../index';

beforeAll(async () => {
  if (!server.listening) await once(server, 'listening');
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const preflight = (path: string, origin: string) =>
  request(server)
    .options(path)
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type')
    .set('X-Forwarded-For', '203.0.113.50');

it('answers a preflight from an allowed origin with a 2-hour max-age', async () => {
  for (const path of ['/api/optimize', '/api/hotels/search', '/api/plan/activities', '/api/canvas/t/save']) {
    const res = await preflight(path, 'https://bluemurr.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://bluemurr.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-max-age']).toBe('7200');
  }
});

it('still refuses an origin that is not on the list — no allow-origin, so there is nothing for the browser to cache', async () => {
  const res = await preflight('/api/optimize', 'https://evil.example');
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});

it('preflights are answered before the rate limiters, so they spend no budget', async () => {
  for (let i = 0; i < 5; i++) await preflight('/api/optimize', 'https://bluemurr.com');
  const res = await request(server)
    .post('/api/optimize')
    .set('Origin', 'https://bluemurr.com')
    .set('X-Forwarded-For', '203.0.113.50')
    .send({});
  expect(res.status).toBe(400); // reached the handler's validation
  expect(res.headers['access-control-allow-origin']).toBe('https://bluemurr.com');
  // The first counted call for this IP: limit minus one.
  expect(Number(res.headers['ratelimit-remaining'])).toBe(Number(res.headers['ratelimit-limit']) - 1);
});
