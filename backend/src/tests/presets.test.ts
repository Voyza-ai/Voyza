jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    CRON_SECRET: 'cron-secret',
  },
}));

// DB mode is switchable per test: 'missing' = table absent (pre-migration
// fallback), 'live' = rows come from `dbRows`, events from `dbEvents`.
let dbMode: 'missing' | 'live' = 'missing';
let dbRows: any[] = [];
let dbEvents: any[] = [];
const rpcCalls: any[] = [];

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    rpc: jest.fn(async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return { error: null };
    }),
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
import {
  budgetTier,
  categoriesFor,
  durationBucket,
  presetFacts,
  presetRegion,
  type PresetData,
} from '../services/presetTaxonomy';
import { bundledCatalog, toRow } from '../services/presets';
import {
  flagsFor,
  slugify,
  validateGenerated,
  wikimediaThumb,
} from '../services/presetGeneration';

const app = express();
app.use(express.json());
app.use('/api/presets', presetsRouter);
app.use(errorHandler);

const city = (over: any = {}) => ({
  name: 'Rome',
  country: 'Italy',
  nights: 2,
  hotel: { name: 'H', rating: 8.5, pricePerNight: 150, area: 'Centro' },
  activities: ['Colosseum', 'Vatican'],
  restaurants: [{ name: 'R', cuisine: 'Italian', priceRange: '$$' }],
  vibes: ['history'],
  ...over,
});

beforeEach(() => {
  dbMode = 'missing';
  dbRows = [];
  dbEvents = [];
  rpcCalls.length = 0;
});

describe('taxonomy', () => {
  it('buckets durations and budget tiers at the documented edges', () => {
    expect(durationBucket(4)).toBe('weekend');
    expect(durationBucket(5)).toBe('one-week');
    expect(durationBucket(9)).toBe('two-weeks');
    expect(durationBucket(16)).toBe('month');
    expect(budgetTier(749)).toBe('$');
    expect(budgetTier(750)).toBe('$$');
    expect(budgetTier(1500)).toBe('$$$');
    expect(budgetTier(3000)).toBe('$$$$');
  });

  it('derives region by nights-weighted majority', () => {
    const p = {
      travelers: 2,
      cities: [city({ country: 'Japan', nights: 1 }), city({ country: 'Italy', nights: 5 })],
    } as PresetData;
    expect(presetRegion(p)).toBe('europe');
  });

  it('cost matches the frontend formula (rooms sleep 2, transport per person)', () => {
    const p = {
      travelers: 3,
      cities: [
        city({ nights: 2, transportOut: { mode: 'train', operator: 'X', duration: '1h', price: 30 } }),
        city({ nights: 1 }),
      ],
    } as PresetData;
    // hotels: (150*2 + 150*1) * 2 rooms = 900; transport: 30 * 3 = 90
    expect(presetFacts(p).estCost).toBe(990);
  });

  it('assigns category membership from facts', () => {
    const romanticEurope = presetFacts({
      travelers: 2,
      cities: [city({ vibes: ['romance', 'food'], nights: 3 })],
    } as PresetData);
    const cats = categoriesFor(romanticEurope);
    expect(cats).toEqual(expect.arrayContaining(['romance-in-europe', 'food-trips', 'weekend-getaways']));
    expect(cats).not.toContain('asia-adventures');
  });

  it('every bundled preset gets a region, buckets, and at least one category', () => {
    for (const { data, source } of bundledCatalog()) {
      const row = toRow(data, source);
      expect(row.categories.length).toBeGreaterThan(0);
      expect(row.nights).toBeGreaterThan(0);
      expect(row.est_cost).toBeGreaterThan(0);
    }
  });
});

describe('editorial: staff-pick criteria', () => {
  it('picks exist, have photos, number ≤ 6, and span ≥ 2 regions and ≥ 2 lengths', () => {
    const editorial = require('../data/presets/editorial.json');
    const bySlug = new Map(bundledCatalog().map((b) => [b.data.slug, b.data]));
    const picks = editorial.staffPicks.map((s: string) => bySlug.get(s));
    expect(picks.every(Boolean)).toBe(true);
    expect(picks.length).toBeLessThanOrEqual(6);
    expect(picks.every((p: PresetData) => !!p.coverImage)).toBe(true);
    const facts = picks.map((p: PresetData) => presetFacts(p));
    expect(new Set(facts.map((f: any) => f.region)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(facts.map((f: any) => f.durationBucket)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('generation validation', () => {
  const combo = { vibe: 'history' as const, region: 'europe' as const, duration: 'weekend' as const, tier: '$' as const };
  const good = {
    title: 'Roman Holiday',
    tagline: 't',
    description: 'd',
    searchTags: ['Ruins'],
    coverImageWikipediaTitle: 'Colosseum',
    // 3 nights × $150, 2 travelers sharing one room = $450 total
    budgetEstimateTotal: 480,
    cities: [city({ nights: 3 })],
  };

  it('accepts a sound trip and normalizes it', () => {
    const { preset, problems } = validateGenerated(good, combo, 0);
    expect(problems).toEqual([]);
    expect(preset!.slug).toBe('roman-holiday');
    expect(preset!.flags).toBe('🇮🇹');
    expect(preset!.scope).toBe('One country');
    expect(preset!.searchTags).toEqual(['ruins']);
    expect(preset!.budgetEstimate).toBe(240); // stored per person
  });

  it("records the AI budget estimate, and flags (doesn't reject) a big mismatch", () => {
    const r = validateGenerated({ ...good, budgetEstimateTotal: 2000 }, combo, 0);
    expect(r.problems).toEqual([]);
    expect(r.preset!.budgetEstimate).toBe(1000);
    expect(r.warnings.join()).toMatch(/AI budget estimate \$2000 vs priced \$450 total/);
    expect(validateGenerated({ ...good, budgetEstimateTotal: undefined }, combo, 0).problems.join())
      .toMatch(/missing budget estimate/);
  });

  it('rejects implausible transport prices', () => {
    const r = validateGenerated(
      {
        ...good,
        cities: [
          city({ nights: 2, transportOut: { mode: 'train', operator: 'X', duration: '1h', price: 9999 } }),
          city({ nights: 1 }),
        ],
      },
      combo,
      0,
    );
    expect(r.problems.join()).toMatch(/implausible transport price 9999/);
  });

  it('rejects a trip priced more than one tier away from the requested tier', () => {
    const r = validateGenerated(good, { ...combo, tier: '$$$' }, 0);
    expect(r.problems.join()).toMatch(/priced \$\/person, requested \$\$\$/);
    // one tier off is tolerated
    expect(validateGenerated(good, { ...combo, tier: '$$' }, 0).problems).toEqual([]);
  });

  it('the --all batch covers every taxonomy combination once', () => {
    const { allTaxonomyCombos } = require('../services/presetGeneration');
    const all = allTaxonomyCombos();
    expect(all).toHaveLength(8 * 5 * 4 * 4);
    expect(new Set(all.map((c: any) => `${c.vibe}|${c.region}|${c.duration}|${c.tier}`)).size).toBe(all.length);
  });

  it('rejects implausible prices, wrong durations, and wrong regions', () => {
    const r1 = validateGenerated({ ...good, cities: [city({ nights: 3, hotel: { ...city().hotel, pricePerNight: 5 } })] }, combo, 0);
    expect(r1.problems.join()).toMatch(/implausible hotel price/);
    const r2 = validateGenerated({ ...good, cities: [city({ nights: 9 })] }, combo, 0);
    expect(r2.problems.join()).toMatch(/outside the weekend bucket/);
    const r3 = validateGenerated({ ...good, cities: [city({ nights: 3, country: 'Japan' })] }, combo, 0);
    expect(r3.problems.join()).toMatch(/region asia/);
  });

  it('requires inter-city transport and strips it from the last city', () => {
    const twoCities = {
      ...good,
      cities: [city({ nights: 2 }), city({ nights: 1, transportOut: { mode: 'train', operator: 'X', duration: '1h', price: 20 } })],
    };
    expect(validateGenerated(twoCities, combo, 0).problems.join()).toMatch(/city 0: missing\/invalid transportOut/);
  });

  it('helpers: slugify, flags, wikimedia thumbs', () => {
    expect(slugify('Côte d’Azur & Provence!')).toBe('cote-d-azur-and-provence');
    expect(flagsFor(['France', 'Italy', 'France'])).toBe('🇫🇷 🇮🇹');
    expect(
      wikimediaThumb('https://upload.wikimedia.org/wikipedia/commons/a/ab/Big_Ben.jpg'),
    ).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Big_Ben.jpg/1280px-Big_Ben.jpg');
    // Newer REST API shape: thumb host + tracking params → clean 1280px URL.
    expect(
      wikimediaThumb(
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/96/Pyramids.jpg/3840px-Pyramids.jpg?utm_source=en.wikipedia.org',
      ),
    ).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/Pyramids.jpg/1280px-Pyramids.jpg');
  });

  it('every country the taxonomy knows also has a flag', () => {
    const { REGION_BY_COUNTRY } = require('../services/presetTaxonomy');
    const { ISO2 } = require('../services/presetGeneration');
    const missing = Object.keys(REGION_BY_COUNTRY).filter((c) => !ISO2[c]);
    expect(missing).toEqual([]);
  });

  it('"Turks & Caicos" resolves to the Americas and gets its flag', () => {
    expect(presetRegion({ travelers: 2, cities: [city({ country: 'Turks & Caicos' })] } as PresetData)).toBe('americas');
    expect(flagsFor(['Turks & Caicos'])).toBe('🇹🇨');
  });

  it('keeps card titles short: drops a ": subtitle" and rejects long titles', () => {
    const r = validateGenerated({ ...good, title: 'Nile Kingdoms: Egypt Timeless Wonders' }, combo, 0);
    expect(r.preset!.title).toBe('Nile Kingdoms');
    expect(r.preset!.slug).toBe('nile-kingdoms');
    const long = validateGenerated(
      { ...good, title: 'An Extraordinarily Long Journey Through Ancient Rome' },
      combo,
      0,
    );
    expect(long.problems.join()).toMatch(/title too long/);
  });
});

describe('GET /api/presets', () => {
  it('serves the bundled catalog when the table does not exist yet', async () => {
    const res = await request(app).get('/api/presets');
    expect(res.status).toBe(200);
    expect(res.body.presets.length).toBe(bundledCatalog().length);
    expect(res.body.editorial.staffPicks).toContain('japan-golden-route');
    expect(res.body.editorial.trending).toEqual([]);
    expect(res.body.categories.length).toBeGreaterThan(0);
  });

  it('ranks the trending row by last-7-day engagement from the DB', async () => {
    dbMode = 'live';
    dbRows = bundledCatalog().map(({ data, source }) => toRow(data, source));
    dbEvents = [
      { preset_slug: 'paris-long-weekend', kind: 'view' },
      { preset_slug: 'greek-island-escape', kind: 'use' }, // a use outweighs a view
      { preset_slug: 'paris-long-weekend', kind: 'impression' },
    ];
    const res = await request(app).get('/api/presets');
    expect(res.body.editorial.trending.slice(0, 2)).toEqual(['greek-island-escape', 'paris-long-weekend']);
  });
});

describe('GET /api/presets/category/:slug', () => {
  it('returns the category with its presets, cheapest first', async () => {
    const res = await request(app).get('/api/presets/category/asia-adventures');
    expect(res.status).toBe(200);
    expect(res.body.category.seoTitle).toMatch(/Asia/);
    const costs = res.body.presets.map((p: any) => p.costPerPerson);
    expect(costs).toEqual([...costs].sort((a: number, b: number) => a - b));
    expect(res.body.presets.every((p: any) => p.region === 'asia')).toBe(true);
  });

  it('404s an unknown category', async () => {
    expect((await request(app).get('/api/presets/category/nope')).status).toBe(404);
  });
});

describe('POST /api/presets/events', () => {
  it('records each unique event once per beacon', async () => {
    const res = await request(app)
      .post('/api/presets/events')
      .send({
        events: [
          { slug: 'paris-long-weekend', kind: 'view' },
          { slug: 'paris-long-weekend', kind: 'view' },
          { slug: 'paris-long-weekend', kind: 'use' },
        ],
      });
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toEqual({ fn: 'record_preset_event', args: { p_slug: 'paris-long-weekend', p_kind: 'view' } });
  });

  it('rejects unknown event kinds', async () => {
    const res = await request(app).post('/api/presets/events').send({ events: [{ slug: 'x', kind: 'like' }] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/presets/run-refresh', () => {
  it('requires the cron secret', async () => {
    expect((await request(app).post('/api/presets/run-refresh')).status).toBe(401);
  });
});
