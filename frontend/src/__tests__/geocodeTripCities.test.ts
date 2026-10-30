/**
 * Map-tab pins for the trip's own cities come from the location resolver,
 * not from a 1-per-1.1-second queue on public Nominatim (audit D-12: a cold
 * Map tab took 7.3 s). Nominatim stays as the fallback for anything the
 * resolver does not answer outright.
 */
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { geocodeTripCities, geocodeCities } from '@/lib/geocode';

const nominatimCalls = () =>
  mockFetch.mock.calls.filter(([url]) => String(url).includes('nominatim.openstreetmap.org'));
const resolverCalls = () =>
  mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/locations/resolve'));

/** Server answers, keyed by the query the client sends. */
function serve(resolver: Record<string, unknown>, nominatim: Record<string, unknown[]> = {}) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/locations/resolve')) {
      const { query } = JSON.parse(String(init?.body));
      const answer = resolver[query];
      if (answer === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => answer ?? { status: 'unknown', suggestions: [] } };
    }
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
    return { ok: true, json: async () => nominatim[q] ?? [] };
  });
}

const resolved = (name: string, lat: number, lon: number) => ({
  status: 'resolved',
  place: { placeId: `gn:${name}`, name, country: 'IT', admin: null, kind: 'city', lat, lon },
  airports: [],
  via: 'qualifier-pinned',
});

beforeEach(() => {
  window.localStorage.clear();
  mockFetch.mockReset();
});

describe('geocodeTripCities', () => {
  it('answers hot-set cities with no request at all', async () => {
    serve({});
    const points = await geocodeTripCities(['Paris, France', 'New York']);
    expect(points[0]).toEqual({ lat: 48.8534, lon: 2.3488 });
    expect(points[1]).toEqual({ lat: 40.7143, lon: -74.006 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks our resolver, in parallel, for cities the hot set lacks — never Nominatim', async () => {
    serve({
      'Florence, Italy': resolved('Florence', 43.7792, 11.2463),
      'Venice, Italy': resolved('Venice', 45.4371, 12.3326),
      'Prague, Czechia': resolved('Prague', 50.088, 14.4208),
    });
    const started = Date.now();
    const points = await geocodeTripCities(['Florence, Italy', 'Venice, Italy', 'Prague, Czechia']);
    // Three Nominatim lookups would have taken at least 3 × 1.1 s.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(points).toEqual([
      { lat: 43.7792, lon: 11.2463 },
      { lat: 45.4371, lon: 12.3326 },
      { lat: 50.088, lon: 14.4208 },
    ]);
    expect(resolverCalls()).toHaveLength(3);
    expect(nominatimCalls()).toHaveLength(0);
  });

  it('remembers resolver answers for the page load, so a re-render does not ask again', async () => {
    // (A city no earlier test asked for: the memo lives for the module.)
    serve({ 'Bologna, Italy': resolved('Bologna', 44.4938, 11.3387) });
    await geocodeTripCities(['Bologna, Italy']);
    await geocodeTripCities(['Bologna, Italy']);
    expect(resolverCalls()).toHaveLength(1);
  });

  it('falls back to Nominatim for a name the resolver cannot settle (ambiguous)', async () => {
    serve(
      { Portland: { status: 'ambiguous', reason: 'multi-country', candidates: [] } },
      { Portland: [{ lat: '45.5202', lon: '-122.6742', class: 'boundary', type: 'administrative' }] },
    );
    const [point] = await geocodeTripCities(['Portland']);
    expect(point).toMatchObject({ lat: 45.5202, lon: -122.6742 });
    expect(nominatimCalls()).toHaveLength(1);
  });

  it('falls back to Nominatim when our server cannot be reached', async () => {
    serve(
      { 'Krakow, Poland': 'fail' },
      { 'Krakow, Poland': [{ lat: '50.0619', lon: '19.9369' }] },
    );
    const [point] = await geocodeTripCities(['Krakow, Poland']);
    expect(point).toMatchObject({ lat: 50.0619, lon: 19.9369 });
    expect(nominatimCalls()).toHaveLength(1);
  });

  it('keeps a pin this browser already cached from Nominatim exactly where it was', async () => {
    window.localStorage.setItem(
      'voyza.geo.v1',
      JSON.stringify({ 'paris, france': { lat: 48.8535, lon: 2.3484, osmClass: 'boundary' } }),
    );
    serve({});
    const [point] = await geocodeTripCities(['Paris, France']);
    expect(point).toEqual({ lat: 48.8535, lon: 2.3484, osmClass: 'boundary' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null, in place, for a name nobody can find', async () => {
    serve({});
    const points = await geocodeTripCities(['Paris, France', 'Atlantis-Nowhere']);
    expect(points[0]).not.toBeNull();
    expect(points[1]).toBeNull();
  });
});

describe('geocodeTripCities — one request per name, however many callers (F6)', () => {
  // Integrated run, 2026-10-30: the Map tab asks for its pins twice at once
  // (its effect re-runs), and a name the resolver cannot settle — Interlaken,
  // an ambiguous London or Moscow — went to /api/locations/resolve twice and
  // to Nominatim twice, the second 1.1 s later in the queue.
  it('shares an in-flight lookup instead of repeating it', async () => {
    serve({ 'Interlaken, Switzerland': { status: 'unknown', suggestions: [] } });
    const [a, b] = await Promise.all([
      geocodeTripCities(['Interlaken, Switzerland']),
      geocodeTripCities(['Interlaken, Switzerland']),
    ]);
    expect(a).toEqual([null]);
    expect(b).toEqual([null]);
    // Before: 2 and 2.
    expect(resolverCalls()).toHaveLength(1);
    expect(nominatimCalls()).toHaveLength(1);
  }, 10000);

  it('asks again once the lookup has settled with no answer (a later visit may get one)', async () => {
    serve({ 'Grindelwald, Switzerland': { status: 'unknown', suggestions: [] } });
    await geocodeTripCities(['Grindelwald, Switzerland']);
    await geocodeTripCities(['Grindelwald, Switzerland']);
    expect(nominatimCalls()).toHaveLength(2);
  }, 10000);

  it('a found place is cached, so even a later caller makes no request', async () => {
    serve(
      { 'Lauterbrunnen, Switzerland': { status: 'unknown', suggestions: [] } },
      { 'Lauterbrunnen, Switzerland': [{ lat: '46.5935', lon: '7.9091' }] },
    );
    await Promise.all([
      geocodeTripCities(['Lauterbrunnen, Switzerland']),
      geocodeTripCities(['Lauterbrunnen, Switzerland']),
    ]);
    await geocodeTripCities(['Lauterbrunnen, Switzerland']);
    expect(nominatimCalls()).toHaveLength(1);
  }, 10000);
});

describe('geocodeCities (sights, hotels, day trips) is unchanged', () => {
  it('still asks Nominatim even for a name the resolver would answer, and keeps its class', async () => {
    serve({}, { 'Paris, France': [{ lat: '48.8535', lon: '2.3484', class: 'boundary', type: 'administrative' }] });
    const [point] = await geocodeCities(['Paris, France']);
    expect(point).toEqual({ lat: 48.8535, lon: 2.3484, osmClass: 'boundary', osmType: 'administrative' });
    expect(resolverCalls()).toHaveLength(0);
    expect(nominatimCalls()).toHaveLength(1);
  });
});
