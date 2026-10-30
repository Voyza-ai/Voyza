/**
 * Rate limits, driven through the REAL app: src/index.ts as it boots, with
 * its own middleware order (helmet, cors, body parsing, the limiters, the
 * routers, requireAuth) and its own listening server. One client IP per
 * scenario, sent the way Railway delivers it: in X-Forwarded-For, with
 * `trust proxy` 1.
 *
 * At 54fd844 the caps were 30 expensive / 100 general per IP per 15 minutes.
 * One 5-city plan is 17 expensive calls (optimize + 5 hotels + 5 activities +
 * 5 restaurants + chat-suggestions), a planner chat turn is one more, and
 * every open canvas tab polls its role every 25 s — 36 times a window — on
 * the general budget. So the second trip from one IP 429'd part-way through
 * (and the frontend swallows 429s, so its cities just came back empty), and
 * two canvas tabs used 72 of the general 100 on their own.
 *
 * Requests carry bodies the handlers reject (400) or no auth (401): the
 * limiters run before either, so every one of them is counted exactly as a
 * real call would be, and none of them reaches a network.
 *
 * NODE_ENV is 'production' because the limiters skip 'test' and
 * 'development' — it is the only setting where there is anything to observe.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'production',
    PORT: 0,
    CORS_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  },
}));
// Booting with NODE_ENV=production would start the weekly preset refresh.
jest.mock('../services/presets', () => ({
  ...jest.requireActual('../services/presets'),
  startPresetRefreshScheduler: jest.fn(() => () => {}),
}));
// Access logging only; production's `combined` format would print ~3,000 lines.
jest.mock('morgan', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import { once } from 'events';
import request from 'supertest';
import { server } from '../index';
import { RATE_LIMITS } from '../middleware/rateLimit';

beforeAll(async () => {
  if (!server.listening) await once(server, 'listening');
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

type Call = { method: 'GET' | 'POST'; path: string; body?: object };

/** One call as Railway hands it to us: the client's address appended to X-Forwarded-For. */
async function send(ip: string, call: Call, forwardedFor?: string) {
  const req =
    call.method === 'GET' ? request(server).get(call.path) : request(server).post(call.path).send(call.body ?? {});
  return req.set('X-Forwarded-For', forwardedFor ?? ip);
}

/** Runs calls in order; returns every status and the calls that were refused. */
async function run(ip: string, calls: Call[]) {
  const refused: string[] = [];
  const statuses: number[] = [];
  for (const [i, call] of calls.entries()) {
    const res = await send(ip, call);
    statuses.push(res.status);
    if (res.status === 429) refused.push(`#${i + 1} ${call.method} ${call.path}`);
  }
  return { refused, statuses };
}

const CITIES = ['Paris', 'Amsterdam', 'Berlin', 'Prague', 'Vienna'];

/** What PlanningChat fires for one N-city plan after "Find my trip": 3N + 2 expensive calls. */
function plan(cities = CITIES): Call[] {
  const each = (path: string): Call[] => cities.map(() => ({ method: 'POST' as const, path }));
  return [
    { method: 'POST', path: '/api/optimize' },
    ...each('/api/hotels/search'),
    ...each('/api/plan/activities'),
    ...each('/api/plan/restaurants'),
    // Valid, and with no API key configured it answers from its fallback list.
    { method: 'POST', path: '/api/plan/chat-suggestions', body: { currentTrip: { cities: [] } } },
  ];
}

const chatTurns = (n: number): Call[] =>
  Array.from({ length: n }, () => ({ method: 'POST' as const, path: '/api/plan/converse', body: {} }));

/** Canvas tabs left open for a full window: one role poll per tab per 25 s, plus refocus refreshes. */
function canvasTabs(tabs: number, refocuses: number): Call[] {
  const pollsPerTab = Math.floor((15 * 60) / 25) + 1; // 37: both ends of the window
  const calls: Call[] = [];
  for (let t = 0; t < tabs; t++) {
    for (let p = 0; p < pollsPerTab; p++) calls.push({ method: 'GET', path: `/api/canvas/trip-${t}/role` });
  }
  for (let r = 0; r < refocuses; r++) calls.push({ method: 'GET', path: `/api/canvas/trip-${r % tabs}/role` });
  return calls;
}

/** Spread `extra` evenly through `base`, the way a poll interleaves with whatever the user is doing. */
function interleave(base: Call[], extra: Call[]): Call[] {
  const out: Call[] = [];
  const every = Math.max(1, Math.floor(base.length / Math.max(1, extra.length)));
  let e = 0;
  base.forEach((c, i) => {
    out.push(c);
    if (i % every === 0 && e < extra.length) out.push(extra[e++]);
  });
  return out.concat(extra.slice(e));
}

describe('normal use is never refused', () => {
  it('two full 5-city plans, a 10-turn planner chat and two canvas tabs open, from one IP: zero 429s', async () => {
    const work = [...chatTurns(10), ...plan(), ...plan()];
    const calls = interleave(work, canvasTabs(2, 10));
    expect(work).toHaveLength(44); // 10 + 2 × 17
    expect(calls).toHaveLength(44 + 84);

    const { refused, statuses } = await run('203.0.113.10', calls);
    expect(refused).toEqual([]);
    // Every call reached its handler: validation (400), auth (401) or a
    // fallback answer (200) — never the limiter.
    expect(new Set(statuses)).toEqual(new Set([200, 400, 401]));
  }, 60_000);

  it('the heavy session the caps are sized for — 10 five-city plans, a 40-turn chat, two canvas tabs and the signed-in bookkeeping — from one IP: zero 429s', async () => {
    const plans = Array.from({ length: 10 }, () => plan()).flat();
    const bookkeeping: Call[] = Array.from({ length: 100 }, () => ({ method: 'GET', path: '/api/trips' }));
    const work = interleave([...chatTurns(40), ...plans], bookkeeping);
    const calls = interleave(work, canvasTabs(2, 30));

    const { refused } = await run('203.0.113.11', calls);
    expect(refused).toEqual([]);
  }, 120_000);
});

describe('a flood is still refused', () => {
  it(`the expensive cap: call ${RATE_LIMITS.expensive + 1} to a paid-API route in one window is refused`, async () => {
    expect(RATE_LIMITS.expensive).toBe(300);
    const { refused } = await run('198.51.100.20', chatTurns(RATE_LIMITS.expensive + 1));
    expect(refused).toEqual([`#${RATE_LIMITS.expensive + 1} POST /api/plan/converse`]);
  }, 60_000);

  it(`the optimize cap: optimize ${RATE_LIMITS.optimize + 1} is refused while the cheaper paid routes still have budget`, async () => {
    expect(RATE_LIMITS.optimize).toBe(40);
    const ip = '198.51.100.21';
    const optimizes: Call[] = Array.from({ length: RATE_LIMITS.optimize + 1 }, () => ({
      method: 'POST',
      path: '/api/optimize',
    }));
    const { refused } = await run(ip, optimizes);
    expect(refused).toEqual([`#${RATE_LIMITS.optimize + 1} POST /api/optimize`]);
    expect((await send(ip, { method: 'POST', path: '/api/hotels/search' })).status).toBe(400);
  }, 60_000);

  it(`the general cap: call ${RATE_LIMITS.general + 1} in one window is refused`, async () => {
    expect(RATE_LIMITS.general).toBe(600);
    const calls: Call[] = Array.from({ length: RATE_LIMITS.general + 1 }, () => ({ method: 'GET', path: '/api/trips' }));
    const { refused } = await run('198.51.100.22', calls);
    expect(refused).toEqual([`#${RATE_LIMITS.general + 1} GET /api/trips`]);
  }, 60_000);

  it('the canvas role poll has its own cap, and spends none of the general budget', async () => {
    expect(RATE_LIMITS.canvasRole).toBe(600);
    const ip = '198.51.100.23';
    const polls: Call[] = Array.from({ length: RATE_LIMITS.canvasRole + 1 }, () => ({
      method: 'GET',
      path: '/api/canvas/trip-a/role',
    }));
    const { refused } = await run(ip, polls);
    expect(refused).toEqual([`#${RATE_LIMITS.canvasRole + 1} GET /api/canvas/trip-a/role`]);

    // 601 polls later, the general budget for this IP is untouched.
    const res = await send(ip, { method: 'GET', path: '/api/trips' });
    expect(res.status).toBe(401);
    expect(res.headers['ratelimit-remaining']).toBe(String(RATE_LIMITS.general - 1));
  }, 60_000);

  it('only the role poll is exempt from the general budget, not the other canvas routes', async () => {
    const ip = '198.51.100.24';
    for (const path of ['/api/canvas/trip-a/members/apply-role', '/api/canvas/trip-a/roles', '/api/canvas/trip-a/role/x']) {
      const before = await send(ip, { method: 'GET', path: '/api/trips' });
      await send(ip, { method: 'GET', path });
      const after = await send(ip, { method: 'GET', path: '/api/trips' });
      // The call in between was counted: two bookkeeping calls plus it.
      expect(Number(before.headers['ratelimit-remaining']) - Number(after.headers['ratelimit-remaining'])).toBe(2);
    }
  });
});

describe("keyed on the client behind Railway's proxy", () => {
  it('a client cannot buy a fresh budget by rotating the X-Forwarded-For entries it sends itself', async () => {
    // With trust proxy 1, the address that counts is the one Railway's proxy
    // appended LAST. Whatever the client prepends is not trusted.
    const real = '198.51.100.30';
    let refused = 0;
    for (let i = 0; i < RATE_LIMITS.optimize + 5; i++) {
      const res = await send(real, { method: 'POST', path: '/api/optimize' }, `10.0.${i}.1, ${real}`);
      if (res.status === 429) refused++;
    }
    expect(refused).toBe(5);
  }, 60_000);

  it('two clients do not share a budget', async () => {
    const a = '198.51.100.31';
    const b = '198.51.100.32';
    const optimizes: Call[] = Array.from({ length: RATE_LIMITS.optimize + 1 }, () => ({
      method: 'POST',
      path: '/api/optimize',
    }));
    expect((await run(a, optimizes)).refused).toHaveLength(1);
    expect((await send(b, { method: 'POST', path: '/api/optimize' })).status).toBe(400);
  }, 60_000);
});
