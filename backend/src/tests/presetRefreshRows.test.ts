/**
 * Which rows a preset refresh touches, and how it holds them (audit E6):
 * only due rows, claimed with a conditional update so a second process
 * can't refresh the same row, failed rows backing off instead of
 * re-running every tick, and every write checked.
 *
 * The "database" is an in-memory preset_trips shared by every module
 * instance, so two isolated copies of presets.ts behave like two backend
 * processes pointed at the one Supabase project.
 */
const mockEnv: Record<string, any> = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
jest.mock('../config/env', () => ({ env: mockEnv }));

const mockCompareLeg = jest.fn();
jest.mock('../services/compareLeg', () => ({ compareLeg: (p: any) => mockCompareLeg(p) }));
const mockSearchHotels = jest.fn();
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: (p: any) => mockSearchHotels(p),
}));

// failWrite(patch) → true makes that update return a Supabase error.
const mockDb: { rows: any[]; failWrite: (patch: any) => boolean; writes: any[] } = {
  rows: [],
  failWrite: () => false,
  writes: [],
};
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => {
      let patch: any = null;
      let returning = false;
      const filters: Array<(r: any) => boolean> = [];
      const chain: any = {};
      chain.select = () => {
        if (patch) returning = true;
        return chain;
      };
      chain.update = (p: any) => ((patch = p), chain);
      chain.eq = (col: string, val: any) => (filters.push((r) => r[col] === val), chain);
      chain.is = (col: string, val: any) => (filters.push((r) => (r[col] ?? null) === val), chain);
      chain.in = (col: string, vals: any[]) => (filters.push((r) => vals.includes(r[col])), chain);
      chain.then = (res: any, rej: any) => {
        const hit = mockDb.rows.filter((r) => filters.every((f) => f(r)));
        if (patch) {
          mockDb.writes.push(patch);
          if (mockDb.failWrite(patch)) {
            return Promise.resolve({ data: null, error: { message: 'write failed' } }).then(res, rej);
          }
          for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(patch)));
          return Promise.resolve({ data: returning ? JSON.parse(JSON.stringify(hit)) : null, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: JSON.parse(JSON.stringify(hit)), error: null }).then(res, rej);
      };
      return chain;
    },
  }),
}));

import { refreshPresetPrices, resetPresetRefreshState, runScheduledPresetRefresh } from '../services/presets';

const P = '../services/presets';
const city = (name: string, nights: number, extra: any = {}) => ({
  name,
  country: 'Italy',
  nights,
  hotel: { name: `${name} Grand Palace`, rating: 8, pricePerNight: 100, area: '' },
  activities: [],
  restaurants: [],
  vibes: ['history'],
  ...extra,
});
const preset = (slug: string, from: string, to: string) => ({
  slug,
  title: slug,
  tagline: '',
  description: '',
  coverGradient: '',
  flags: '',
  scope: '',
  travelers: 2,
  cities: [
    city(from, 2, { transportOut: { mode: 'train', operator: 'x', duration: '1h', price: 30 } }),
    city(to, 2),
  ],
});
const row = (slug: string, from: string, to: string, extra: any = {}) => ({
  slug,
  data: preset(slug, from, to),
  source: 'curated',
  status: 'published',
  refresh_status: 'fresh',
  refreshed_at: null,
  ...extra,
});

const NOW = new Date('2026-10-29T12:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const NOTHING = { recommendation: 'unavailable', trainOption: null, flightOption: null };
// Every hotel is found live at its curated rate → the preset is 'fresh'.
const liveHotels = async ({ hotelName }: any) => [{ name: hotelName, pricePerNight: 100 }];
const searchedFrom = () => mockCompareLeg.mock.calls.map((c: any[]) => c[0].origin);

beforeEach(() => {
  resetPresetRefreshState();
  mockDb.rows = [];
  mockDb.writes = [];
  mockDb.failWrite = () => false;
  mockCompareLeg.mockReset();
  mockCompareLeg.mockResolvedValue(NOTHING);
  mockSearchHotels.mockReset();
  mockSearchHotels.mockImplementation(liveHotels);
});

describe('only due rows are re-priced', () => {
  it('a row refreshed 20 minutes ago is left alone; a never-refreshed one is re-priced', async () => {
    mockDb.rows = [
      row('recent', 'Rome', 'Florence', { refreshed_at: at(-1 / 3).toISOString() }),
      row('never', 'Milan', 'Turin'),
    ];
    expect(await refreshPresetPrices(NOW)).toEqual({ refreshed: 1, failed: 0, skipped: 1 });
    expect(searchedFrom()).toEqual(['Milan']);
  });

  it('`only` re-prices the named preset even when it is not due', async () => {
    mockDb.rows = [row('recent', 'Rome', 'Florence', { refreshed_at: at(-1).toISOString() })];
    expect(await refreshPresetPrices(NOW, { only: ['recent'] })).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
  });
});

describe('a failing preset backs off; the rest of the catalog is not re-run', () => {
  it('a day of 6-hour ticks: the good preset is re-priced once, the failing one twice (12 h backoff)', async () => {
    mockDb.rows = [row('bad', 'Nowhere', 'Elsewhere'), row('good', 'Rome', 'Florence')];
    mockCompareLeg.mockImplementation(async (p: any) => {
      if (p.origin === 'Nowhere') throw new Error('upstream 502');
      return NOTHING;
    });
    for (const h of [0, 6, 12, 18]) await runScheduledPresetRefresh(at(h));
    const calls = searchedFrom();
    // Old behaviour: 4 and 4 — every tick re-priced the whole catalog.
    expect(calls.filter((o: string) => o === 'Rome')).toHaveLength(1);
    expect(calls.filter((o: string) => o === 'Nowhere')).toHaveLength(2);
    expect(mockDb.rows.find((r) => r.slug === 'bad').refresh_status).toBe('failed');
    expect(mockDb.rows.find((r) => r.slug === 'good').refresh_status).toBe('fresh');
  });

  it('the backoff doubles and is capped at a week', async () => {
    mockDb.rows = [row('bad', 'Nowhere', 'Elsewhere')];
    mockCompareLeg.mockRejectedValue(new Error('upstream 502'));
    const attempts: number[] = [];
    for (let h = 0; h <= 24 * 30; h += 6) {
      const before = mockCompareLeg.mock.calls.length;
      await refreshPresetPrices(at(h));
      if (mockCompareLeg.mock.calls.length > before) attempts.push(h);
    }
    const gaps = attempts.slice(1).map((h, i) => h - attempts[i]);
    expect(gaps.slice(0, 5)).toEqual([12, 24, 48, 96, 168]);
    expect(Math.max(...gaps)).toBe(168);
  });
});

describe('every write is checked', () => {
  it('a failed final write is a failure — not counted refreshed, not stamped fresh, and backed off', async () => {
    mockDb.rows = [row('w', 'Rome', 'Florence')];
    mockDb.failWrite = (patch) => 'data' in patch;
    const r = await refreshPresetPrices(NOW);
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(mockDb.rows[0].refreshed_at).toBeNull();
    // The claim is released rather than left 'refreshing'.
    expect(mockDb.rows[0].refresh_status).toBe('failed');
    // …and the next tick does not hammer it again.
    mockDb.failWrite = () => false;
    expect((await refreshPresetPrices(at(6))).skipped).toBe(1);
  });

  it('a failed claim skips the row without searching anything', async () => {
    mockDb.rows = [row('w', 'Rome', 'Florence')];
    mockDb.failWrite = (patch) => patch.refresh_status === 'refreshing';
    expect(await refreshPresetPrices(NOW)).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    expect(mockCompareLeg).not.toHaveBeenCalled();
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });
});

describe('restarts and a second process', () => {
  it('after a restart mid-run: the finished row is left alone, the abandoned one is reclaimed an hour+ later', async () => {
    mockDb.rows = [
      row('done', 'Rome', 'Florence', { refreshed_at: at(-1 / 3).toISOString() }),
      row('interrupted', 'Milan', 'Turin', { refresh_status: 'refreshing' }),
    ];
    // The post-boot tick: 'interrupted' may be another process mid-refresh.
    expect(await refreshPresetPrices(NOW)).toEqual({ refreshed: 0, failed: 0, skipped: 2 });
    expect(mockCompareLeg).not.toHaveBeenCalled();
    // Six hours on it is still 'refreshing': abandoned. Reclaim it.
    expect(await refreshPresetPrices(at(6))).toEqual({ refreshed: 1, failed: 0, skipped: 1 });
    expect(searchedFrom()).toEqual(['Milan']);
    expect(mockDb.rows.find((r) => r.slug === 'interrupted').refresh_status).toBe('fresh');
  });

  it('two backend processes on one database re-price a row once, not twice', async () => {
    mockDb.rows = [row('dup', 'Rome', 'Florence')];
    mockCompareLeg.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return NOTHING;
    });
    let a: any;
    let b: any;
    jest.isolateModules(() => {
      a = require(P);
    });
    jest.isolateModules(() => {
      b = require(P);
    });
    const [ra, rb] = await Promise.all([a.refreshPresetPrices(NOW), b.refreshPresetPrices(NOW)]);
    expect(ra.refreshed + rb.refreshed).toBe(1);
    expect(ra.skipped + rb.skipped).toBe(1);
    expect(mockCompareLeg).toHaveBeenCalledTimes(1);
  });
});
