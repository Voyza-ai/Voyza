import {
  findNearestAirportCity,
  haversineKm,
  AIRPORT_CITIES,
  detectNearestAirportCity,
} from '@/lib/nearestAirport';

describe('nearestAirport', () => {
  test('haversine: NYC to LA is ~3,940 km', () => {
    const d = haversineKm(40.71, -74.01, 34.05, -118.24);
    expect(d).toBeGreaterThan(3800);
    expect(d).toBeLessThan(4100);
  });

  test('Manhattan coords resolve to New York', () => {
    expect(findNearestAirportCity(40.73, -73.99)?.city).toBe('New York');
  });

  test('suburban user resolves to the nearest metro (Newark, NJ → New York)', () => {
    expect(findNearestAirportCity(40.73, -74.17)?.city).toBe('New York');
  });

  test('Paris coords resolve to Paris', () => {
    expect(findNearestAirportCity(48.85, 2.35)?.city).toBe('Paris');
  });

  test('Tokyo coords resolve to Tokyo', () => {
    expect(findNearestAirportCity(35.68, 139.69)?.city).toBe('Tokyo');
  });

  test('southern-hemisphere coords resolve correctly (Sydney)', () => {
    expect(findNearestAirportCity(-33.9, 151.2)?.city).toBe('Sydney');
  });

  test('returns a sane distance for an exact city-center match', () => {
    const nyc = findNearestAirportCity(40.71, -74.01);
    expect(nyc?.distanceKm).toBeLessThan(5);
  });

  test('invalid coords return null', () => {
    expect(findNearestAirportCity(NaN, 0)).toBeNull();
    expect(findNearestAirportCity(0, Infinity)).toBeNull();
  });

  test('dataset has no duplicate cities', () => {
    const names = AIRPORT_CITIES.map((c) => c.city.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test('multi-airport metros in the dataset align with the airports lookup', () => {
    // These cities must resolve to airports so the optimizer gets IATA
    // codes pre-filled after a location detection.
    const { getOriginAirports } = require('@/lib/originAirports');
    for (const city of ['New York', 'Los Angeles', 'London', 'Tokyo', 'Paris']) {
      expect(getOriginAirports(city).length).toBeGreaterThan(0);
    }
  });

  test('haversine handles the antimeridian (no 40,000 km wraparound)', () => {
    // Two points straddling the date line are ~22 km apart, not the long way.
    expect(haversineKm(0, 179.9, 0, -179.9)).toBeLessThan(30);
  });

  describe('detectNearestAirportCity (browser wrapper)', () => {
    const setGeolocation = (impl: any) =>
      Object.defineProperty(global.navigator, 'geolocation', {
        value: impl,
        configurable: true,
      });

    afterEach(() => {
      // Remove the mock so other tests see jsdom's default (undefined).
      // @ts-expect-error cleanup
      delete global.navigator.geolocation;
    });

    test('permission granted → resolves the nearest city', async () => {
      setGeolocation({
        getCurrentPosition: (ok: any) =>
          ok({ coords: { latitude: 40.73, longitude: -73.99 } }),
      });
      const r = await detectNearestAirportCity();
      expect(r).toMatchObject({ ok: true, city: { city: 'New York' } });
    });

    test('permission denied → { ok: false, reason: denied }', async () => {
      setGeolocation({
        getCurrentPosition: (_ok: any, err: any) => err({ code: 1 }),
      });
      expect(await detectNearestAirportCity()).toEqual({ ok: false, reason: 'denied' });
    });

    test('geolocation unsupported → { ok: false, reason: unsupported }', async () => {
      // No geolocation property at all (jsdom default).
      expect(await detectNearestAirportCity()).toEqual({ ok: false, reason: 'unsupported' });
    });
  });
});
