/**
 * What GET /api/presets serves when the database holds PRODUCTION's rows.
 *
 * Fixture: production's GET /api/presets response, saved 2026-10-30
 * (fixtures/presets-prod-2026-10-29.json). Every row was re-priced at
 * 2026-10-29T06:47:04 by a refresh run with Duffel's TEST token before the
 * PRESET_REFRESH_ENABLED gate existed: 18 legs read "Duffel Airways"
 * (Duffel's sandbox carrier, IATA ZZ) at sandbox fares, and curated prices
 * no longer match curated.json. The rows are rebuilt from that response
 * exactly as preset_trips holds them.
 */
jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    CRON_SECRET: 'cron-secret',
  },
}));

let dbMode: 'missing' | 'live' = 'live';
let dbRows: any[] = [];
let dbEvents: any[] = [];

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    rpc: jest.fn(async () => ({ error: null })),
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'gte', 'limit', 'order']) chain[m] = jest.fn(() => chain);
      chain.then = (res: any, rej: any) => {
        if (dbMode === 'missing') {
          return Promise.resolve({ data: null, error: { message: 'relation "preset_trips" does not exist' } }).then(res, rej);
        }
        const data = table === 'preset_events' ? dbEvents : dbRows;
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
      return chain;
    },
  }),
}));

import express from 'express';
import request from 'supertest';
import presetsRouter from '../routes/presets';
import { errorHandler } from '../middleware/error';
import { bundledCatalog, clearTrendingCache, servableCatalog, toRow } from '../services/presets';
import { presetFacts } from '../services/presetTaxonomy';
import prod from './fixtures/presets-prod-2026-10-29.json';
import curated from '../data/presets/curated.json';
import generated from '../data/presets/generated.json';

const app = express();
app.use(express.json());
app.use('/api/presets', presetsRouter);
app.use(errorHandler);

/** A preset_trips row, rebuilt from one preset of the API response. */
const rowFrom = (p: any) => ({
  slug: p.slug,
  data: p.data,
  vibes: p.vibes,
  region: p.region,
  duration_bucket: p.durationBucket,
  budget_tier: p.budgetTier,
  origin_region: p.origin.region,
  nights: p.nights,
  est_cost: p.estCost,
  categories: p.categories,
  hero_image_url: p.heroImageUrl,
  staff_pick: p.staffPick,
  status: 'published',
  source: p.source,
  refresh_status: 'fresh',
  refreshed_at: p.refreshedAt,
  clone_count: p.cloneCount,
  view_count: p.viewCount,
  impression_count: p.impressionCount,
});
const PROD_ROWS = (prod as any).presets.map(rowFrom);

const legsOf = (presets: any[]) =>
  presets.flatMap((p) =>
    p.data.cities
      .filter((c: any) => c.transportOut)
      .map((c: any) => ({ slug: p.slug, from: c.name, ...c.transportOut })),
  );
const CURATED = new Map((curated as any[]).map((p) => [p.slug, p]));
const GENERATED_SLUGS = (generated as any[]).map((p) => p.slug);

beforeEach(() => {
  dbMode = 'live';
  dbRows = JSON.parse(JSON.stringify(PROD_ROWS));
  dbEvents = [];
  clearTrendingCache();
});

describe('the production fixture is what the brief says it is', () => {
  it('20 rows, one refresh batch, Duffel Airways on curated and generated legs', () => {
    expect(PROD_ROWS).toHaveLength(20);
    expect(new Set(PROD_ROWS.map((r: any) => r.refreshed_at))).toEqual(new Set(['2026-10-29T06:47:04.018+00:00']));
    const duffel = legsOf((prod as any).presets).filter((l) => /Duffel Airways/.test(l.operator));
    expect(duffel.length).toBe(18);
    expect(new Set(duffel.map((l) => l.slug))).toEqual(
      new Set([
        'southeast-asia-adventure', 'south-america-grand-tour', 'italian-renaissance-trail',
        'mediterranean-odyssey', 'grand-asia-expedition', 'greek-island-escape', 'lisbon-sintra-escape',
        'norwegian-fjords-and-mountains', 'mexico-city-and-guadalajara',
        'belgrade-bucharest-nightlife-rush', 'taiwan-food-odyssey',
      ]),
    );
  });
});

describe('GET /api/presets with production rows', () => {
  it('serves no Duffel Airways / ZZ leg anywhere', async () => {
    const res = await request(app).get('/api/presets');
    expect(res.status).toBe(200);
    const legs = legsOf(res.body.presets);
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.filter((l) => /duffel/i.test(l.operator) || /^ZZ\b/.test(l.operator))).toEqual([]);
    expect(JSON.stringify(res.body).match(/Duffel Airways/g) ?? []).toEqual([]);
  });

  it('serves every curated preset exactly as curated.json has it, never the drifted row', async () => {
    const res = await request(app).get('/api/presets');
    const served = res.body.presets.filter((p: any) => p.source === 'curated');
    expect(served.map((p: any) => p.slug).sort()).toEqual([...CURATED.keys()].sort());
    for (const p of served) {
      const truth = CURATED.get(p.slug);
      expect(p.data).toEqual(truth);
      // Derived facts come from the curated data too, not the row's columns.
      const f = presetFacts(truth);
      expect(p.estCost).toBe(f.estCost);
      expect(p.budgetTier).toBe(f.budgetTier);
      expect(p.categories).toEqual(toRow(truth, 'curated').categories);
      // The served data was never refreshed, so it must not claim to be.
      expect(p.refreshedAt).toBeNull();
    }
    // The cases the audit named, spot-checked by value.
    const lisbon = served.find((p: any) => p.slug === 'lisbon-sintra-escape');
    expect(lisbon.data.cities[0].transportOut).toEqual({ mode: 'train', operator: 'CP Urbano', duration: '0h 40m', price: 3 });
    const sea = served.find((p: any) => p.slug === 'southeast-asia-adventure');
    expect(sea.data.cities[0].transportOut.operator).toBe('Bangkok Airways'); // prod row: "British Airways" $43
  });

  it('keeps the row\'s engagement: counts and trending still come from the database', async () => {
    dbEvents = [{ preset_slug: 'grand-asia-expedition', kind: 'use' }];
    const res = await request(app).get('/api/presets');
    const gae = res.body.presets.find((p: any) => p.slug === 'grand-asia-expedition');
    expect(gae.cloneCount).toBe(1);
    expect(gae.viewCount).toBe(2);
    expect(gae.impressionCount).toBe(3);
    expect(gae.trendingScore).toBe(5);
    expect(res.body.editorial.trending[0]).toBe('grand-asia-expedition');
  });

  it('serves none of the 9 generated presets, each for a stated reason', async () => {
    const res = await request(app).get('/api/presets');
    expect(res.body.presets.filter((p: any) => p.source === 'generated')).toEqual([]);
    expect(res.body.presets).toHaveLength(11);

    const { withheld } = servableCatalog(PROD_ROWS);
    const why = new Map(withheld.map((w) => [w.slug, w.reasons.join(' | ')]));
    expect([...why.keys()].sort()).toEqual([...GENERATED_SLUGS].sort());
    // Sandbox carrier on the row itself.
    for (const s of ['norwegian-fjords-and-mountains', 'mexico-city-and-guadalajara', 'belgrade-bucharest-nightlife-rush', 'taiwan-food-odyssey']) {
      expect(why.get(s)).toMatch(/Duffel Airways/);
    }
    // Re-priced by the same test-mode refresh under a real airline's name.
    expect(why.get('ancient-egypt-explorer')).toMatch(/Cairo → Luxor: flight re-priced to Nile Air \$44/);
    // The generator's own validation.
    expect(why.get('thailand-beach-hideaway')).toMatch(/"Ferry \+ Transfer" is not a flight/);
    expect(why.get('taiwan-food-odyssey')).toMatch(/generic hotel name "Hotel A"/);
    // A "flight" between two places the planner reaches through one airport.
    expect(why.get('new-zealand-nature-odyssey')).toMatch(/Queenstown → Mount Cook Village: .*ZQN/);
    expect(why.get('costa-rica-wild-escape')).toMatch(/Monteverde → La Fortuna: .*SJO/);
    expect(why.get('caribbean-beach-bliss')).toMatch(/Playa del Carmen → Cozumel: .*CZM/);
  });

  it('every surface gets the same list: editorial rows, category rows and category pages', async () => {
    const res = await request(app).get('/api/presets');
    const served = new Set(res.body.presets.map((p: any) => p.slug));
    const referenced = [
      ...res.body.editorial.staffPicks,
      ...res.body.editorial.trending,
      ...res.body.categories.flatMap((c: any) => c.presetSlugs),
    ];
    expect(referenced.filter((s: string) => !served.has(s))).toEqual([]);
    for (const c of res.body.categories) {
      const page = await request(app).get(`/api/presets/category/${c.slug}`);
      expect(page.status).toBe(200);
      expect(page.body.presets.map((p: any) => p.slug)).toEqual(c.presetSlugs);
      expect(JSON.stringify(page.body).match(/Duffel Airways/g) ?? []).toEqual([]);
      expect(page.body.presets.every((p: any) => p.source === 'curated')).toBe(true);
    }
  });
});

describe('servableCatalog rules', () => {
  const genRow = (slug: string) => {
    const b = bundledCatalog().find((x) => x.data.slug === slug)!;
    return { ...toRow(JSON.parse(JSON.stringify(b.data)), 'generated'), clone_count: 0 };
  };

  it('serves a generated preset whose row still matches its generator output and passes every check', () => {
    // Mexico City → Guadalajara as generated: Volaris $75, MEX → GDL.
    const { rows, withheld } = servableCatalog([genRow('mexico-city-and-guadalajara')]);
    expect(withheld).toEqual([]);
    expect(rows.map((r) => r.slug)).toEqual(['mexico-city-and-guadalajara']);
  });

  it('drops it again once the row carries Duffel\'s sandbox carrier, by name or by code', () => {
    for (const operator of ['Duffel Airways', 'ZZ 1203']) {
      const row = genRow('mexico-city-and-guadalajara');
      row.data.cities[0].transportOut = { ...row.data.cities[0].transportOut!, operator };
      expect(servableCatalog([row]).rows).toEqual([]);
    }
  });

  it('serves a generated preset from its bundled copy, never the row\'s data', () => {
    const row = genRow('mexico-city-and-guadalajara');
    row.data.cities[0].hotel.pricePerNight = 999; // hotel drift alone is not a sandbox leg
    const { rows } = servableCatalog([row]);
    expect(rows[0].data.cities[0].hotel.pricePerNight).toBe(65);
  });

  it('does not serve a row that is in no bundled catalog', () => {
    const stray = { ...genRow('mexico-city-and-guadalajara'), slug: 'not-in-the-repo' };
    stray.data = { ...stray.data, slug: 'not-in-the-repo' };
    const { rows, withheld } = servableCatalog([stray]);
    expect(rows).toEqual([]);
    expect(withheld[0].reasons.join()).toMatch(/not in the bundled catalog/);
  });
});

describe('no database (table missing / read failed)', () => {
  it('serves the curated trips only: a generated preset needs its row to be checked', async () => {
    dbMode = 'missing';
    const res = await request(app).get('/api/presets');
    expect(res.status).toBe(200);
    expect(res.body.presets.map((p: any) => p.slug).sort()).toEqual([...CURATED.keys()].sort());
    expect(JSON.stringify(res.body).match(/Duffel Airways/g) ?? []).toEqual([]);
  });
});
