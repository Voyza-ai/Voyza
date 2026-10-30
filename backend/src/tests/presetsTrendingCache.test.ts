/**
 * Audit C12: every GET /api/presets (and every SEO category page) re-read up
 * to 50,000 preset_events rows to rank the trending row. The scores are now
 * cached for 60 s and concurrent requests share one read.
 */
jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
}));

const reads = { events: 0, eventsError: false as boolean };
let dbRows: any[] = [];
let dbEvents: any[] = [];
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'gte', 'limit', 'order']) chain[m] = () => chain;
      chain.then = (res: any, rej: any) => {
        if (table === 'preset_events') {
          reads.events++;
          if (reads.eventsError) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej);
          return Promise.resolve({ data: dbEvents, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: dbRows, error: null }).then(res, rej);
      };
      return chain;
    },
  }),
}));

import { bundledCatalog, clearTrendingCache, loadCatalog, toRow } from '../services/presets';

const T0 = new Date('2026-10-29T12:00:00Z');
const plus = (s: number) => new Date(T0.getTime() + s * 1000);
const score = (catalog: any[], slug: string) => catalog.find((p) => p.slug === slug)?.trendingScore;

beforeEach(() => {
  clearTrendingCache();
  reads.events = 0;
  reads.eventsError = false;
  dbRows = bundledCatalog().map(({ data, source }) => toRow(data, source));
  dbEvents = [{ preset_slug: 'paris-long-weekend', kind: 'view' }];
});

describe('trending scores cache (C12)', () => {
  it('serves repeat catalog loads within 60 s from one events read', async () => {
    for (const s of [0, 1, 30, 59]) await loadCatalog(plus(s));
    expect(reads.events).toBe(1);
  });

  it('re-reads after 60 s, and the new events show up', async () => {
    expect(score(await loadCatalog(plus(0)), 'paris-long-weekend')).toBe(1);
    dbEvents = [...dbEvents, { preset_slug: 'paris-long-weekend', kind: 'use' }];
    expect(score(await loadCatalog(plus(59)), 'paris-long-weekend')).toBe(1); // cached
    expect(score(await loadCatalog(plus(60)), 'paris-long-weekend')).toBe(6);
    expect(reads.events).toBe(2);
  });

  it('requests that arrive together share one read', async () => {
    await Promise.all([loadCatalog(plus(0)), loadCatalog(plus(0)), loadCatalog(plus(0))]);
    expect(reads.events).toBe(1);
  });

  it('a failed read is not cached', async () => {
    reads.eventsError = true;
    expect(score(await loadCatalog(plus(0)), 'paris-long-weekend')).toBe(0);
    reads.eventsError = false;
    expect(score(await loadCatalog(plus(1)), 'paris-long-weekend')).toBe(1);
    expect(reads.events).toBe(2);
  });
});
