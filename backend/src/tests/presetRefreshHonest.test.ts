/**
 * What the preset refresh claims, and what it searches (audit E5 / A7):
 * 'fresh' only when a price really came back live, the 3× guard anchored to
 * the BUNDLED curated price, legs priced in their own mode on the day they
 * actually depart, and a dark rail network not counted as an error.
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
const mockDb: { rows: any[] } = { rows: [] };
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
          for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(patch)));
          return Promise.resolve({ data: returning ? JSON.parse(JSON.stringify(hit)) : null, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: JSON.parse(JSON.stringify(hit)), error: null }).then(res, rej);
      };
      return chain;
    },
  }),
}));

import curated from '../data/presets/curated.json';
import { refreshPresetPrices, resetPresetRefreshState } from '../services/presets';

const bundled = (slug: string) => JSON.parse(JSON.stringify((curated as any[]).find((p) => p.slug === slug)));
const rowFor = (data: any, extra: any = {}) => ({
  slug: data.slug,
  data,
  source: 'curated',
  status: 'published',
  refresh_status: 'fresh',
  refreshed_at: null,
  ...extra,
});
const NOTHING = { recommendation: 'unavailable', trainOption: null, flightOption: null };
const NOW = new Date('2026-10-29T12:00:00Z');
const week = (n: number) => new Date(NOW.getTime() + n * 8 * 86_400_000);

beforeEach(() => {
  resetPresetRefreshState();
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  Object.assign(mockEnv, { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  mockDb.rows = [];
  mockCompareLeg.mockReset();
  mockSearchHotels.mockReset();
  mockSearchHotels.mockResolvedValue([]);
  mockCompareLeg.mockResolvedValue(NOTHING);
});

describe("'fresh' means a price really came back live (E5)", () => {
  it('nothing re-priced (every provider empty) → failed, refreshed_at untouched, data untouched', async () => {
    const data = bundled('italian-renaissance-trail');
    mockDb.rows = [rowFor(data, { refreshed_at: '2026-10-01T00:00:00.000Z' })];
    const r = await refreshPresetPrices(NOW);
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(mockDb.rows[0].refresh_status).toBe('failed');
    expect(mockDb.rows[0].refreshed_at).toBe('2026-10-01T00:00:00.000Z');
    expect(mockDb.rows[0].data).toEqual(data);
  });

  it('one hotel re-priced live and nothing failed → fresh, with that price saved', async () => {
    const data = bundled('italian-renaissance-trail');
    mockDb.rows = [rowFor(data)];
    const rome = data.cities[0].hotel;
    mockSearchHotels.mockImplementation(async ({ city }: any) =>
      city === 'Rome' ? [{ name: rome.name, pricePerNight: rome.pricePerNight + 11.4 }] : [],
    );
    const r = await refreshPresetPrices(NOW);
    expect(r).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(mockDb.rows[0].refresh_status).toBe('fresh');
    expect(mockDb.rows[0].refreshed_at).toBe(NOW.toISOString());
    expect(mockDb.rows[0].data.cities[0].hotel.pricePerNight).toBe(rome.pricePerNight + 11);
  });

  it('a search that throws → failed, but the live prices it did get are still saved', async () => {
    const data = bundled('italian-renaissance-trail');
    mockDb.rows = [rowFor(data)];
    const rome = data.cities[0].hotel;
    mockSearchHotels.mockImplementation(async ({ city }: any) => {
      if (city === 'Venice') throw new Error('quota');
      return city === 'Rome' ? [{ name: rome.name, pricePerNight: rome.pricePerNight + 5 }] : [];
    });
    const r = await refreshPresetPrices(NOW);
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(mockDb.rows[0].refresh_status).toBe('failed');
    expect(mockDb.rows[0].refreshed_at).toBeNull();
    expect(mockDb.rows[0].data.cities[0].hotel.pricePerNight).toBe(rome.pricePerNight + 5);
  });

  it('a dark rail network keeps the train fare and is not an error', async () => {
    const data = bundled('italian-renaissance-trail');
    mockDb.rows = [rowFor(data)];
    const rome = data.cities[0].hotel;
    mockSearchHotels.mockImplementation(async ({ city }: any) =>
      city === 'Rome' ? [{ name: rome.name, pricePerNight: rome.pricePerNight }] : [],
    );
    // Rail returns nothing; a flight is all the search finds.
    mockCompareLeg.mockResolvedValue({
      recommendation: 'flight',
      trainOption: null,
      flightOption: { price: 60, carrier: 'ITA', durationMinutes: 60 },
    });
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_live_x';
    expect(await refreshPresetPrices(NOW)).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(mockDb.rows[0].data.cities[0].transportOut).toEqual(data.cities[0].transportOut);
  });
});

describe('legs are priced in their own mode, on the day they depart', () => {
  it('a curated train takes the live TRAIN fare even when a cheaper flight is recommended', async () => {
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_live_x';
    const data = bundled('italian-renaissance-trail'); // Rome → Florence train $45
    mockDb.rows = [rowFor(data)];
    mockCompareLeg.mockImplementation(async ({ origin }: any) =>
      origin === 'Rome'
        ? {
            recommendation: 'flight',
            trainOption: { price: 52, operator: 'Italo', durationMinutes: 95 },
            flightOption: { price: 40, carrier: 'ITA', durationMinutes: 60 },
          }
        : NOTHING,
    );
    await refreshPresetPrices(NOW);
    expect(mockDb.rows[0].data.cities[0].transportOut).toEqual({
      ...data.cities[0].transportOut,
      price: 52,
      duration: '1h 35m',
    });
  });

  it('each leg is searched on the day its city stay ends, like the hotel stays', async () => {
    const data = bundled('imperial-europe-rail'); // 5 cities, 4 train legs
    mockDb.rows = [rowFor(data)];
    await refreshPresetPrices(NOW);
    const stays = mockSearchHotels.mock.calls.map((c: any[]) => c[0]);
    const legs = mockCompareLeg.mock.calls.map((c: any[]) => c[0]);
    expect(stays[0].checkin).toBe('2026-11-28'); // 30 days out
    expect(legs.map((l: any) => `${l.origin} ${l.date}`)).toEqual(
      data.cities.slice(0, -1).map((c: any, i: number) => `${c.name} ${stays[i].checkout}`),
    );
    expect(new Set(legs.map((l: any) => l.date)).size).toBe(4);
  });
});

describe('the 3× guard is anchored to the bundled curated price (A7)', () => {
  it('a fare cannot ratchet 3× per run: $78 curated accepts $226, then refuses $650 and $1,900', async () => {
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_live_x';
    const data = bundled('greek-island-escape'); // Athens → Santorini flight $78
    expect(data.cities[0].transportOut).toMatchObject({ mode: 'flight', price: 78 });
    mockDb.rows = [rowFor(data)];
    const seen: number[] = [];
    for (const [n, fare] of [226, 650, 1900].entries()) {
      mockCompareLeg.mockImplementation(async ({ origin }: any) =>
        origin === 'Athens'
          ? { recommendation: 'flight', trainOption: null, flightOption: { price: fare, carrier: 'X', durationMinutes: 50 } }
          : NOTHING,
      );
      await refreshPresetPrices(week(n));
      seen.push(mockDb.rows[0].data.cities[0].transportOut.price);
    }
    // Old guard (relative to last run): 226, 650, 1900.
    expect(seen).toEqual([226, 226, 226]);
  });

  it('hotels too: anchored to the curated rate, not last run’s', async () => {
    const data = bundled('greek-island-escape');
    const h = data.cities[0].hotel; // Athens
    mockDb.rows = [rowFor(data)];
    for (const [n, mult] of [2.9, 2.9 * 2.9].entries()) {
      mockSearchHotels.mockImplementation(async ({ city }: any) =>
        city === 'Athens' ? [{ name: h.name, pricePerNight: Math.round(h.pricePerNight * mult) }] : [],
      );
      await refreshPresetPrices(week(n));
    }
    expect(mockDb.rows[0].data.cities[0].hotel.pricePerNight).toBe(Math.round(h.pricePerNight * 2.9));
  });

  it('a preset not in the bundle falls back to its own current price as the anchor', async () => {
    mockEnv.DUFFEL_ACCESS_TOKEN = 'duffel_live_x';
    const data = { ...bundled('greek-island-escape'), slug: 'db-only' };
    mockDb.rows = [rowFor(data)];
    mockCompareLeg.mockImplementation(async ({ origin }: any) =>
      origin === 'Athens'
        ? { recommendation: 'flight', trainOption: null, flightOption: { price: 200, carrier: 'X', durationMinutes: 50 } }
        : NOTHING,
    );
    await refreshPresetPrices(NOW);
    expect(mockDb.rows[0].data.cities[0].transportOut.price).toBe(200);
  });
});
