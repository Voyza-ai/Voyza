/**
 * The general limiter must NOT count `/api/locations`.
 *
 * The failure this prevents: naming an origin city is a typeahead, so one
 * person can spend a dozen calls on a single field. Counted against the
 * shared 100-per-15-minutes `/api` budget, those calls 429 the actual
 * planning flow — the user gets "too many requests" on the thing they were
 * trying to do, caused by the autocomplete that was helping them.
 *
 * This runs with NODE_ENV='production' because the limiter skips `test` and
 * `development` entirely, so it is the only setting where the behaviour
 * exists to observe at all.
 *
 * It proves the exclusion rather than the limiter being inert: a control
 * route under the same `/api` prefix is driven past the same budget in the
 * same app and MUST be rejected. Without that half, deleting the limiter
 * would make this suite pass.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'production',
    LOCATION_RESOLVER_MODE: 'shadow',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  },
}));

import express from 'express';
import request from 'supertest';

import locations from '../routes/locations';
import { apiLimiter, locationLimiter } from '../middleware/rateLimit';

/** The general budget, from rateLimit.ts. */
const GENERAL_MAX = 100;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Same order as src/index.ts: general limiter over all of /api, then the
  // location limiter over its own prefix.
  app.use('/api', apiLimiter);
  app.use('/api/locations', locationLimiter);
  app.use('/api/locations', locations);
  // A control route that IS metered, to prove the limiter is live.
  app.get('/api/control', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('the general limiter', () => {
  // One app for both halves, so they genuinely share the same IP budget.
  const app = makeApp();

  it('rejects a control route under /api once the budget is spent', async () => {
    let rejected = 0;
    for (let i = 0; i < GENERAL_MAX + 5; i += 1) {
      const res = await request(app).get('/api/control');
      if (res.status === 429) rejected += 1;
    }
    // The non-vacuity half: if this is 0, the limiter is not running and the
    // assertion below means nothing.
    expect(rejected).toBeGreaterThan(0);
  }, 60_000);

  it('still serves /api/locations after that budget is gone', async () => {
    // Same app, same client, general budget already exhausted by the test
    // above. A metered route is 429 by now; this one must not be.
    const res = await request(app).post('/api/locations/resolve').send({ query: 'nyc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
  }, 30_000);

  it('still bounds /api/locations with its own, higher budget', async () => {
    // Excluded from the shared budget is not the same as unmetered. The
    // route's own limiter reports a cap, and it is the high one.
    const res = await request(app).post('/api/locations/resolve').send({ query: 'nyc' });
    expect(Number(res.headers['ratelimit-limit'])).toBe(600);
  }, 30_000);
});
