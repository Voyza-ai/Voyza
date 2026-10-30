/**
 * The preset price refresh is a writer into the ONE Supabase project that
 * also holds real trips. These pin the promotion-blocking guards (audit E3 /
 * C10 / E6): it never starts unless switched on, it never accepts a Duffel
 * sandbox fare or carrier name, and POST /run-refresh is secret-guarded,
 * obeys the same switch and can't overlap a running refresh.
 */
const mockEnv: Record<string, any> = {};
jest.mock('../config/env', () => ({ env: mockEnv }));

const mockCompareLeg = jest.fn();
jest.mock('../services/compareLeg', () => ({ compareLeg: (p: any) => mockCompareLeg(p) }));
const mockSearchHotels = jest.fn();
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: (p: any) => mockSearchHotels(p),
}));

// In-memory preset_trips: every query filters it, every update patches it.
const mockDb: { rows: any[]; queries: number } = { rows: [], queries: 0 };
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => {
      mockDb.queries++;
      let patch: any = null;
      let returning = false;
      const filters: Array<(r: any) => boolean> = [];
      const chain: any = {};
      chain.select = () => {
        if (patch) returning = true;
        return chain;
      };
      chain.update = (p: any) => {
        patch = p;
        return chain;
      };
      chain.eq = (col: string, val: any) => (filters.push((r) => r[col] === val), chain);
      chain.neq = (col: string, val: any) => (filters.push((r) => r[col] !== val), chain);
      chain.is = (col: string, val: any) => (filters.push((r) => (r[col] ?? null) === val), chain);
      chain.in = (col: string, vals: any[]) => (filters.push((r) => vals.includes(r[col])), chain);
      chain.then = (res: any, rej: any) => {
        const hit = mockDb.rows.filter((r) => filters.every((f) => f(r)));
        if (patch) {
          for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(patch)));
          const data = returning ? JSON.parse(JSON.stringify(hit)) : null;
          return Promise.resolve({ data, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: JSON.parse(JSON.stringify(hit)), error: null }).then(res, rej);
      };
      return chain;
    },
  }),
}));

import express from 'express';
import request from 'supertest';
import presetsRouter from '../routes/presets';
import { errorHandler } from '../middleware/error';
import {
  refreshPresetPrices,
  startPresetRefreshScheduler,
  withPresetRefreshLock,
} from '../services/presets';
import { logger } from '../utils/logger';

const app = express();
app.use(express.json());
app.use('/api/presets', presetsRouter);
app.use(errorHandler);

const city = (name: string, country: string, nights: number, extra: any = {}) => ({
  name,
  country,
  nights,
  hotel: { name: `${name} Grand Palace`, rating: 8, pricePerNight: 100, area: '' },
  activities: [],
  restaurants: [],
  vibes: ['history'],
  ...extra,
});
// The audit's case: a curated Vietnam Airlines hop that a Duffel TEST token
// re-prices as "Duffel Airways" at nearly 3× the fare.
const vietnam = () => ({
  slug: 'vietnam',
  title: 'Vietnam',
  tagline: '',
  description: '',
  coverGradient: '',
  flags: '',
  scope: '',
  travelers: 2,
  cities: [
    city('Hanoi', 'Vietnam', 2, {
      transportOut: { mode: 'flight', operator: 'Vietnam Airlines', duration: '1h 20m', price: 64 },
    }),
    city('Hoi An', 'Vietnam', 3),
  ],
});
const SANDBOX_FARE = {
  recommendation: 'flight',
  trainOption: null,
  flightOption: { price: 180, carrier: 'Duffel Airways', durationMinutes: 75 },
};

const NOW = new Date('2026-10-29T12:00:00Z');

beforeEach(() => {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  Object.assign(mockEnv, {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    CRON_SECRET: 'cron-secret',
  });
  mockDb.rows = [
    {
      slug: 'vietnam',
      data: vietnam(),
      source: 'curated',
      status: 'published',
      refresh_status: 'fresh',
      refreshed_at: null,
    },
  ];
  mockDb.queries = 0;
  mockCompareLeg.mockReset();
  mockSearchHotels.mockReset();
  mockSearchHotels.mockResolvedValue([]);
  mockCompareLeg.mockResolvedValue(SANDBOX_FARE);
});

describe('startPresetRefreshScheduler: off unless PRESET_REFRESH_ENABLED', () => {
  afterEach(() => jest.useRealTimers());

  const runADay = async () => {
    // Past the 10-minute first tick and four 6-hour ticks.
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 11 * 60 * 1000);
  };

  it('schedules nothing and touches neither the DB nor any provider when the flag is unset', async () => {
    jest.useFakeTimers();
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const stop = startPresetRefreshScheduler();
    expect(jest.getTimerCount()).toBe(0);
    await runADay();
    stop();
    expect(mockDb.queries).toBe(0);
    expect(mockCompareLeg).not.toHaveBeenCalled();
    expect(mockSearchHotels).not.toHaveBeenCalled();
    expect(mockDb.rows[0].data).toEqual(vietnam());
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/scheduler disabled/));
    info.mockRestore();
  });

  it('treats anything but "true" as off (the env transform yields false)', () => {
    jest.useFakeTimers();
    mockEnv.PRESET_REFRESH_ENABLED = false;
    const stop = startPresetRefreshScheduler();
    expect(jest.getTimerCount()).toBe(0);
    stop();
  });

  it('starts when PRESET_REFRESH_ENABLED=true, and says so', async () => {
    jest.useFakeTimers();
    mockEnv.PRESET_REFRESH_ENABLED = true;
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const stop = startPresetRefreshScheduler();
    expect(jest.getTimerCount()).toBe(2);
    await runADay();
    stop();
    expect(mockDb.queries).toBeGreaterThan(0);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/scheduler enabled/),
      expect.objectContaining({ liveFlightFares: false }),
    );
    info.mockRestore();
  });
});

describe('refreshPresetPrices: no sandbox fares, curated operator kept', () => {
  it('a Duffel TEST token never replaces a flight fare or its operator', async () => {
    mockEnv.PRESET_REFRESH_ENABLED = true;
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_test_abc';
    await refreshPresetPrices(NOW);
    expect(mockDb.rows[0].data.cities[0].transportOut).toEqual({
      mode: 'flight',
      operator: 'Vietnam Airlines',
      duration: '1h 20m',
      price: 64,
    });
    // …and the unusable search wasn't even made.
    expect(mockCompareLeg).not.toHaveBeenCalled();
  });

  it('no token at all is treated the same (cached fares were written by the test token)', async () => {
    await refreshPresetPrices(NOW);
    expect(mockDb.rows[0].data.cities[0].transportOut.price).toBe(64);
    expect(mockDb.rows[0].data.cities[0].transportOut.operator).toBe('Vietnam Airlines');
  });

  it('records why the curated fare was kept', async () => {
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_test_abc';
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    await refreshPresetPrices(NOW);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/kept curated/),
      expect.objectContaining({ slug: 'vietnam', kept: [expect.stringMatching(/Hanoi → Hoi An: no live Duffel token/)] }),
    );
    info.mockRestore();
  });

  it('a test token cannot slip a flight in where no curated fare exists', async () => {
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_test_abc';
    const data = vietnam();
    delete (data.cities[0] as any).transportOut;
    mockDb.rows[0].data = data;
    await refreshPresetPrices(NOW);
    expect(mockDb.rows[0].data.cities[0].transportOut).toBeUndefined();
  });

  it('a LIVE token updates the fare but keeps the curated operator', async () => {
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_live_abc';
    mockCompareLeg.mockResolvedValue({
      recommendation: 'flight',
      trainOption: null,
      flightOption: { price: 71, carrier: 'Bamboo Airways', durationMinutes: 80 },
    });
    await refreshPresetPrices(NOW);
    expect(mockDb.rows[0].data.cities[0].transportOut).toEqual({
      mode: 'flight',
      operator: 'Vietnam Airlines',
      duration: '1h 20m',
      price: 71,
    });
  });
});

describe('POST /api/presets/run-refresh', () => {
  it('refuses without the secret, even with the refresh enabled', async () => {
    mockEnv.PRESET_REFRESH_ENABLED = true;
    expect((await request(app).post('/api/presets/run-refresh')).status).toBe(401);
    expect(
      (await request(app).post('/api/presets/run-refresh').set('x-cron-secret', 'wrong')).status,
    ).toBe(401);
    expect(mockDb.queries).toBe(0);
  });

  it('is unavailable when no CRON_SECRET is configured (cannot be triggered secret-less)', async () => {
    mockEnv.PRESET_REFRESH_ENABLED = true;
    delete mockEnv.CRON_SECRET;
    expect((await request(app).post('/api/presets/run-refresh')).status).toBe(503);
    expect(
      (await request(app).post('/api/presets/run-refresh').set('x-cron-secret', '')).status,
    ).toBe(503);
    expect(mockDb.queries).toBe(0);
  });

  it('refuses with the right secret while PRESET_REFRESH_ENABLED is off', async () => {
    const res = await request(app).post('/api/presets/run-refresh').set('x-cron-secret', 'cron-secret');
    expect(res.status).toBe(503);
    expect(mockDb.queries).toBe(0);
  });

  it('runs with the secret and the flag', async () => {
    mockEnv.PRESET_REFRESH_ENABLED = true;
    const res = await request(app).post('/api/presets/run-refresh').set('x-cron-secret', 'cron-secret');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('refuses (409) while another refresh holds the lock, instead of running a second one', async () => {
    mockEnv.PRESET_REFRESH_ENABLED = true;
    let release!: () => void;
    const holding = withPresetRefreshLock(() => new Promise<void>((r) => (release = r)));
    const res = await request(app).post('/api/presets/run-refresh').set('x-cron-secret', 'cron-secret');
    expect(res.status).toBe(409);
    expect(mockDb.queries).toBe(0);
    release();
    await holding;
    // Lock released → the next call runs.
    expect(
      (await request(app).post('/api/presets/run-refresh').set('x-cron-secret', 'cron-secret')).status,
    ).toBe(200);
  });
});
