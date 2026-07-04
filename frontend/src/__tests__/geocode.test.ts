/**
 * geocode.ts — Nominatim lookup with localStorage cache.
 * Network is mocked; the throttle makes each UNCACHED lookup take ~1.1s of
 * real time, so tests keep uncached lookups to a minimum.
 */
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { geocodeCity, geocodeCities } from '@/lib/geocode';

beforeEach(() => {
  window.localStorage.clear();
  mockFetch.mockReset();
});

describe('geocodeCity', () => {
  test('resolves via Nominatim and caches in localStorage', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ lat: '43.7696', lon: '11.2558' }],
    });

    const first = await geocodeCity('Florence');
    expect(first).toEqual({ lat: 43.7696, lon: 11.2558 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('q=Florence');

    // Second call must come from the cache — no new network request.
    const second = await geocodeCity('florence  ');
    expect(second).toEqual({ lat: 43.7696, lon: 11.2558 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(window.localStorage.getItem('voyza.geo.v1')!);
    expect(stored['florence']).toEqual({ lat: 43.7696, lon: 11.2558 });
  });

  test('returns null when the geocoder has no answer (no invented pins)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    const point = await geocodeCity('Atlantis-Nowhere');
    expect(point).toBeNull();
    // Failures are NOT cached — a later retry is allowed.
    const stored = JSON.parse(window.localStorage.getItem('voyza.geo.v1') ?? '{}');
    expect(stored['atlantis-nowhere']).toBeUndefined();
  });
});

describe('geocodeCities', () => {
  test('preserves input order using cache', async () => {
    window.localStorage.setItem(
      'voyza.geo.v1',
      JSON.stringify({
        'new york': { lat: 40.71, lon: -74.01 },
        rome: { lat: 41.89, lon: 12.48 },
      }),
    );
    const points = await geocodeCities(['New York', 'Rome']);
    expect(points).toEqual([
      { lat: 40.71, lon: -74.01 },
      { lat: 41.89, lon: 12.48 },
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
