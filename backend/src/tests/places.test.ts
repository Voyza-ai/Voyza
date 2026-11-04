/**
 * POI provider layer for the geo-aware day planner (services/places):
 * provider selection, the Nominatim rate limit and cache, query building,
 * the deadline/pending contract of resolvePlaces, and Distance Matrix legs.
 */
jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    PORT: 4000,
  },
}));

import { createThrottle, ThrottleFullError } from '../services/places/throttle';
import { TtlCache } from '../services/places/cache';
import { cleanPlaceQuery, properNounPrefix, queriesFor } from '../services/places/query';
import {
  foursquareProvider,
  googlePlacesProvider,
  nominatimProvider,
  NOMINATIM_USER_AGENT,
} from '../services/places/providers';
import {
  __setProviderForTests,
  cachedPlacesAndPrefetch,
  resolvePlaces,
  selectProvider,
  type PoiProvider,
} from '../services/places';
import { travelLegs, __clearTravelCacheForTests } from '../services/places/travel';

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

// Louvre-ish and a point ~1 km away, both in central Paris.
const PARIS = { lat: 48.8566, lng: 2.3522 };

describe('selectProvider', () => {
  it('prefers Google, then Foursquare, then keyless Nominatim', () => {
    expect(selectProvider({ GOOGLE_PLACES_API_KEY: 'g', FOURSQUARE_API_KEY: 'f' }).name).toBe('google');
    expect(selectProvider({ FOURSQUARE_API_KEY: 'f' }).name).toBe('foursquare');
    expect(selectProvider({}).name).toBe('osm');
    expect(selectProvider({ GOOGLE_PLACES_API_KEY: '' }).name).toBe('osm');
  });
});

describe('createThrottle', () => {
  it('starts tasks at least minGap apart, one at a time, in order', async () => {
    let clock = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const t = createThrottle(1100, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    let running = 0;
    let maxRunning = 0;
    const task = (i: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      starts.push(clock);
      clock += 200; // the request itself takes 200 ms
      running--;
      return i;
    };
    const results = await Promise.all([0, 1, 2, 3].map((i) => t.run(task(i))));
    expect(results).toEqual([0, 1, 2, 3]);
    expect(maxRunning).toBe(1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1100);
  });

  it('keeps going after a task fails', async () => {
    const t = createThrottle(0);
    await expect(t.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(t.run(async () => 5)).resolves.toBe(5);
  });

  it('refuses work beyond maxQueued instead of queueing it', async () => {
    const t = createThrottle(0, { maxQueued: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = t.run(() => gate);
    const b = t.run(async () => 1);
    await expect(t.run(async () => 2)).rejects.toBeInstanceOf(ThrottleFullError);
    expect(t.size()).toBe(2);
    release();
    await a;
    await b;
    expect(t.size()).toBe(0);
  });
});

describe('TtlCache', () => {
  it('expires entries and evicts least-recently-used', () => {
    let now = 0;
    const c = new TtlCache<number | null>(2, () => now);
    c.set('a', 1, 100);
    c.set('b', null, 100);
    expect(c.get('b')).toBeNull(); // a cached miss is distinguishable from absent
    c.get('a'); // a is now most recent
    c.set('c', 3, 100);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    now = 101;
    expect(c.get('a')).toBeUndefined();
  });
});

describe('query building', () => {
  it('strips timing filler and keeps the place', () => {
    expect(cleanPlaceQuery('Louvre Museum early-entry morning')).toBe('Louvre Museum');
    expect(cleanPlaceQuery('Sunset walk at the')).toBe('');
  });
  it('takes the leading proper noun, keeping name particles', () => {
    expect(properNounPrefix('Senso-ji Temple and Asakusa old town')).toBe('Senso-ji Temple');
    expect(properNounPrefix("Musée d'Orsay impressionists")).toBe("Musée d'Orsay");
  });
  it('tries placeQuery first, scopes to city, never queries the bare city, max two', () => {
    expect(queriesFor({ name: 'Colosseum early entry', placeQuery: 'Colosseo' }, 'Rome', 'Italy')).toEqual([
      'Colosseo, Rome, Italy',
      'Colosseum, Rome, Italy',
    ]);
    expect(queriesFor({ name: 'Paris' }, 'Paris', 'France')).toEqual([]);
    // No single-word prefix fallback: "Wine" would pin an unrelated wine shop.
    expect(queriesFor({ name: 'Wine tasting in Le Marais' }, 'Paris', 'France')).toEqual([
      'Wine tasting in Le Marais, Paris, France',
    ]);
    expect(queriesFor({ name: 'Senso-ji Temple and Asakusa old town' }, 'Tokyo')).toEqual([
      'Senso-ji Temple and Asakusa old town, Tokyo',
      'Senso-ji Temple, Tokyo',
    ]);
  });
});

describe('providers', () => {
  it('Nominatim: identifying User-Agent, bounded viewbox around the city, osm placeId, settlement flag', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonRes([{ lat: '48.8611', lon: '2.3380', osm_id: 7515426, osm_type: 'relation', category: 'tourism', type: 'museum', name: 'Louvre' }]),
    );
    const p = nominatimProvider({ fetchImpl: fetchImpl as any, throttle: createThrottle(0) });
    const hit = await p.search('Louvre, Paris, France', PARIS);
    expect(hit).toEqual({ lat: 48.8611, lng: 2.338, placeId: 'osm:R7515426', name: 'Louvre', settlement: false });
    const [url, init] = (fetchImpl.mock.calls[0] as any[]) as [string, RequestInit];
    expect((init.headers as any)['User-Agent']).toBe(NOMINATIM_USER_AGENT);
    expect(NOMINATIM_USER_AGENT).toMatch(/BlueMurr/);
    const q = new URL(url).searchParams;
    expect(q.get('bounded')).toBe('1');
    expect(q.get('viewbox')!.split(',').map(Number)).toEqual([
      expect.closeTo(2.0522, 3),
      expect.closeTo(49.1566, 3),
      expect.closeTo(2.6522, 3),
      expect.closeTo(48.5566, 3),
    ]);

    fetchImpl.mockResolvedValueOnce(jsonRes([{ lat: '48.85', lon: '2.35', osm_id: 1, osm_type: 'node', category: 'place', type: 'city' }]));
    expect((await p.search('x', PARIS))!.settlement).toBe(true);
    fetchImpl.mockResolvedValueOnce(jsonRes([]));
    expect(await p.search('nothing', PARIS)).toBeNull();
    fetchImpl.mockResolvedValueOnce(jsonRes({}, false, 429));
    await expect(p.search('busy', PARIS)).rejects.toThrow('429');
  });

  it('Nominatim calls go through the shared 1 req/s throttle', async () => {
    let clock = 0;
    const starts: number[] = [];
    const throttle = createThrottle(1100, { now: () => clock, sleep: async (ms) => { clock += ms; } });
    const fetchImpl = jest.fn(async () => {
      starts.push(clock);
      return jsonRes([]);
    });
    const p = nominatimProvider({ fetchImpl: fetchImpl as any, throttle });
    await Promise.all(['a', 'b', 'c'].map((q) => p.search(q, PARIS)));
    expect(starts).toEqual([0, 1100, 2200]);
  });

  it('Google Places (New): key + field mask headers, location bias, area types rejected', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonRes({ places: [{ id: 'ChIJ1', displayName: { text: 'Louvre' }, location: { latitude: 48.86, longitude: 2.33 }, types: ['museum', 'point_of_interest'] }] }),
    );
    const p = googlePlacesProvider('KEY', fetchImpl as any);
    expect(await p.search('Louvre', PARIS)).toEqual({ lat: 48.86, lng: 2.33, placeId: 'google:ChIJ1', name: 'Louvre', settlement: false });
    const [url, init] = (fetchImpl.mock.calls[0] as any[]) as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect((init.headers as any)['X-Goog-Api-Key']).toBe('KEY');
    expect((init.headers as any)['X-Goog-FieldMask']).toContain('places.location');
    expect(JSON.parse(init.body as string).locationBias.circle.center).toEqual({ latitude: PARIS.lat, longitude: PARIS.lng });

    fetchImpl.mockResolvedValueOnce(jsonRes({ places: [{ id: 'x', location: { latitude: 48.8, longitude: 2.3 }, types: ['locality', 'political'] }] }));
    expect((await p.search('Paris', PARIS))!.settlement).toBe(true);
  });

  it('Foursquare: bearer key, ll + radius, new and legacy response shapes', async () => {
    const fetchImpl = jest.fn(async () => jsonRes({ results: [{ fsq_place_id: 'abc', name: 'Café', latitude: 48.85, longitude: 2.34 }] }));
    const p = foursquareProvider('FSQ', fetchImpl as any);
    expect(await p.search('Café', PARIS)).toEqual({ lat: 48.85, lng: 2.34, placeId: 'fsq:abc', name: 'Café' });
    const [url, init] = (fetchImpl.mock.calls[0] as any[]) as [string, RequestInit];
    expect(new URL(url).searchParams.get('ll')).toBe(`${PARIS.lat},${PARIS.lng}`);
    expect((init.headers as any).Authorization).toBe('Bearer FSQ');
    fetchImpl.mockResolvedValueOnce(jsonRes({ results: [{ fsq_id: 'old', geocodes: { main: { latitude: 1, longitude: 2 } } }] }));
    expect((await p.search('x', null))!.placeId).toBe('fsq:old');
  });
});

describe('resolvePlaces', () => {
  const near = (dLat: number, dLng: number) => ({ lat: PARIS.lat + dLat, lng: PARIS.lng + dLng });
  afterEach(() => __setProviderForTests(null));

  function fakeProvider(answers: Record<string, any>, delays: Record<string, number> = {}): PoiProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      name: 'osm',
      calls,
      async search(query) {
        calls.push(query);
        if (delays[query]) await new Promise((r) => setTimeout(r, delays[query]));
        const a = answers[query];
        if (a instanceof Error) throw a;
        return a ?? null;
      },
    };
  }

  it('returns real coordinates in input order; centre comes from the location artifact, not the provider', async () => {
    const p = fakeProvider({
      'Louvre, Paris, France': { ...near(0.005, -0.014), placeId: 'osm:R1' },
      "Musée d'Orsay, Paris, France": { ...near(0.003, -0.026), placeId: 'osm:W2' },
    });
    __setProviderForTests(p);
    const out = await resolvePlaces('Paris', 'France', [{ name: 'Louvre' }, { name: "Musée d'Orsay" }, { name: 'Sunset walk' }], { deadlineMs: 2000 });
    expect(out[0]).toMatchObject({ name: 'Louvre', placeId: 'osm:R1' });
    expect(out[1]).toMatchObject({ placeId: 'osm:W2' });
    expect(out[2]).toEqual({ name: 'Sunset walk' });
    expect(p.calls).not.toContain('Paris, France'); // centre resolved offline
  });

  it('rejects settlements and far-away matches, falling through to the next query', async () => {
    __setProviderForTests(
      fakeProvider({
        'Montmartre stroll, Paris, France': { lat: 48.88, lng: 2.34, placeId: 'osm:R9', settlement: true },
        'Montmartre, Paris, France': { lat: 48.886, lng: 2.343, placeId: 'osm:N5' },
        'Central Park, Paris, France': { lat: 40.78, lng: -73.96, placeId: 'osm:NYC' },
      }),
    );
    const out = await resolvePlaces('Paris', 'France', [{ name: 'Montmartre stroll' }, { name: 'Central Park' }], { deadlineMs: 2000 });
    expect(out[0].placeId).toBe('osm:N5');
    expect(out[1].lat).toBeUndefined();
  });

  it('caches hits and misses: the second call asks the provider nothing', async () => {
    const p = fakeProvider({ 'Louvre, Paris, France': { ...near(0, 0), placeId: 'osm:R1' } });
    __setProviderForTests(p);
    await resolvePlaces('Paris', 'France', [{ name: 'Louvre' }, { name: 'Nowhere Bar' }], { deadlineMs: 2000 });
    const n = p.calls.length;
    const again = await resolvePlaces('Paris', 'France', [{ name: 'Louvre' }, { name: 'Nowhere Bar' }], { deadlineMs: 2000 });
    expect(p.calls.length).toBe(n);
    expect(again[0].placeId).toBe('osm:R1');
  });

  it('shares one lookup between concurrent callers', async () => {
    const p = fakeProvider({ 'Louvre, Paris, France': { ...near(0, 0), placeId: 'osm:R1' } }, { 'Louvre, Paris, France': 30 });
    __setProviderForTests(p);
    await Promise.all([
      resolvePlaces('Paris', 'France', [{ name: 'Louvre' }], { deadlineMs: 2000 }),
      resolvePlaces('Paris', 'France', [{ name: 'Louvre' }], { deadlineMs: 2000 }),
    ]);
    expect(p.calls.filter((c) => c === 'Louvre, Paris, France')).toHaveLength(1);
  });

  it('answers by the deadline with pending items, which finish into the cache', async () => {
    const p = fakeProvider({ 'Slow Place, Paris, France': { ...near(0, 0), placeId: 'osm:S' } }, { 'Slow Place, Paris, France': 150 });
    __setProviderForTests(p);
    const t0 = Date.now();
    const first = await resolvePlaces('Paris', 'France', [{ name: 'Slow Place' }], { deadlineMs: 20 });
    expect(Date.now() - t0).toBeLessThan(140);
    expect(first[0]).toEqual({ name: 'Slow Place', pending: true });
    await new Promise((r) => setTimeout(r, 200));
    const second = await resolvePlaces('Paris', 'France', [{ name: 'Slow Place' }], { deadlineMs: 0 });
    expect(second[0].placeId).toBe('osm:S');
  });

  it('a transport failure is not cached as a miss', async () => {
    const answers: Record<string, any> = { 'Louvre, Paris, France': new Error('timeout') };
    const p = fakeProvider(answers);
    __setProviderForTests(p);
    expect((await resolvePlaces('Paris', 'France', [{ name: 'Louvre' }], { deadlineMs: 2000 }))[0].lat).toBeUndefined();
    answers['Louvre, Paris, France'] = { ...near(0, 0), placeId: 'osm:R1' };
    expect((await resolvePlaces('Paris', 'France', [{ name: 'Louvre' }], { deadlineMs: 2000 }))[0].placeId).toBe('osm:R1');
  });

  it('cachedPlacesAndPrefetch answers instantly and starts the lookups', async () => {
    const p = fakeProvider({ 'Louvre, Paris, France': { ...near(0, 0), placeId: 'osm:R1' } });
    __setProviderForTests(p);
    expect(cachedPlacesAndPrefetch('Paris', 'France', [{ name: 'Louvre' }])).toEqual([{ name: 'Louvre', pending: true }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(cachedPlacesAndPrefetch('Paris', 'France', [{ name: 'Louvre' }])[0].placeId).toBe('osm:R1');
  });
});

describe('travelLegs (Distance Matrix)', () => {
  beforeEach(() => __clearTravelCacheForTests());
  const pts = [
    { placeId: 'a', lat: 48.86, lng: 2.33 },
    { placeId: 'b', lat: 48.87, lng: 2.34 },
  ];

  it('is null without a Google key (the client estimates instead)', async () => {
    expect(await travelLegs(pts, { apiKey: '' })).toBeNull();
  });

  it('walks when walking is short, else takes the faster transit; caches pairs', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      const mode = new URL(url).searchParams.get('mode');
      const el = (min: number) => ({ status: 'OK', duration: { value: min * 60 }, distance: { value: 1500 } });
      const self = { status: 'OK', duration: { value: 0 }, distance: { value: 0 } };
      return jsonRes({
        status: 'OK',
        rows: [
          { elements: [self, mode === 'walking' ? el(18) : el(12)] },
          { elements: [mode === 'walking' ? el(35) : el(14), self] },
        ],
      });
    });
    const legs = await travelLegs(pts, { apiKey: 'K', fetchImpl: fetchImpl as any });
    expect(legs!['a>b']).toEqual({ minutes: 18, distanceKm: 1.5, mode: 'walk' });
    expect(legs!['b>a']).toEqual({ minutes: 14, distanceKm: 1.5, mode: 'transit' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await travelLegs(pts, { apiKey: 'K', fetchImpl: fetchImpl as any });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
