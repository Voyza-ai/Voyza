/**
 * Nearest-airport-city lookup for the "Use my location" flow in the planner.
 *
 * Given browser geolocation coords, finds the closest major airport city
 * from an embedded dataset — no network call, no API key, instant. The
 * returned city name feeds the same origin path as a typed answer:
 * `getOriginAirports(city)` pre-fills IATA codes for multi-airport metros,
 * and the backend's getIataCode() handles the rest.
 *
 * Coordinates are city centers (≈0.1° precision) — plenty for "which major
 * airport is closest", which only needs to be right at ~100 km scale.
 */

export type AirportCity = {
  city: string;
  country: string;
  lat: number;
  lon: number;
};

export const AIRPORT_CITIES: AirportCity[] = [
  // ── North America ──
  { city: 'New York', country: 'United States', lat: 40.71, lon: -74.01 },
  { city: 'Philadelphia', country: 'United States', lat: 39.95, lon: -75.17 },
  { city: 'Boston', country: 'United States', lat: 42.36, lon: -71.06 },
  { city: 'Washington', country: 'United States', lat: 38.91, lon: -77.04 },
  { city: 'Pittsburgh', country: 'United States', lat: 40.44, lon: -80.0 },
  { city: 'Atlanta', country: 'United States', lat: 33.75, lon: -84.39 },
  { city: 'Charlotte', country: 'United States', lat: 35.23, lon: -80.84 },
  { city: 'Nashville', country: 'United States', lat: 36.16, lon: -86.78 },
  { city: 'Miami', country: 'United States', lat: 25.76, lon: -80.19 },
  { city: 'Orlando', country: 'United States', lat: 28.54, lon: -81.38 },
  { city: 'Tampa', country: 'United States', lat: 27.95, lon: -82.46 },
  { city: 'New Orleans', country: 'United States', lat: 29.95, lon: -90.07 },
  { city: 'Chicago', country: 'United States', lat: 41.88, lon: -87.63 },
  { city: 'Detroit', country: 'United States', lat: 42.33, lon: -83.05 },
  { city: 'Minneapolis', country: 'United States', lat: 44.98, lon: -93.27 },
  { city: 'St Louis', country: 'United States', lat: 38.63, lon: -90.2 },
  { city: 'Kansas City', country: 'United States', lat: 39.1, lon: -94.58 },
  { city: 'Indianapolis', country: 'United States', lat: 39.77, lon: -86.16 },
  { city: 'Columbus', country: 'United States', lat: 39.96, lon: -83.0 },
  { city: 'Cincinnati', country: 'United States', lat: 39.1, lon: -84.51 },
  { city: 'Dallas', country: 'United States', lat: 32.78, lon: -96.8 },
  { city: 'Houston', country: 'United States', lat: 29.76, lon: -95.37 },
  { city: 'Austin', country: 'United States', lat: 30.27, lon: -97.74 },
  { city: 'Denver', country: 'United States', lat: 39.74, lon: -104.99 },
  { city: 'Salt Lake City', country: 'United States', lat: 40.76, lon: -111.89 },
  { city: 'Phoenix', country: 'United States', lat: 33.45, lon: -112.07 },
  { city: 'Las Vegas', country: 'United States', lat: 36.17, lon: -115.14 },
  { city: 'Los Angeles', country: 'United States', lat: 34.05, lon: -118.24 },
  { city: 'San Diego', country: 'United States', lat: 32.72, lon: -117.16 },
  { city: 'San Francisco', country: 'United States', lat: 37.77, lon: -122.42 },
  { city: 'Sacramento', country: 'United States', lat: 38.58, lon: -121.49 },
  { city: 'Portland', country: 'United States', lat: 45.52, lon: -122.68 },
  { city: 'Seattle', country: 'United States', lat: 47.61, lon: -122.33 },
  { city: 'Honolulu', country: 'United States', lat: 21.31, lon: -157.86 },
  { city: 'Toronto', country: 'Canada', lat: 43.65, lon: -79.38 },
  { city: 'Montreal', country: 'Canada', lat: 45.5, lon: -73.57 },
  { city: 'Vancouver', country: 'Canada', lat: 49.28, lon: -123.12 },
  { city: 'Calgary', country: 'Canada', lat: 51.05, lon: -114.07 },
  { city: 'Mexico City', country: 'Mexico', lat: 19.43, lon: -99.13 },
  { city: 'Cancun', country: 'Mexico', lat: 21.16, lon: -86.85 },

  // ── Europe ──
  { city: 'London', country: 'United Kingdom', lat: 51.51, lon: -0.13 },
  { city: 'Manchester', country: 'United Kingdom', lat: 53.48, lon: -2.24 },
  { city: 'Edinburgh', country: 'United Kingdom', lat: 55.95, lon: -3.19 },
  { city: 'Dublin', country: 'Ireland', lat: 53.35, lon: -6.26 },
  { city: 'Paris', country: 'France', lat: 48.86, lon: 2.35 },
  { city: 'Nice', country: 'France', lat: 43.7, lon: 7.27 },
  { city: 'Amsterdam', country: 'Netherlands', lat: 52.37, lon: 4.9 },
  { city: 'Brussels', country: 'Belgium', lat: 50.85, lon: 4.35 },
  { city: 'Frankfurt', country: 'Germany', lat: 50.11, lon: 8.68 },
  { city: 'Munich', country: 'Germany', lat: 48.14, lon: 11.58 },
  { city: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.4 },
  { city: 'Zurich', country: 'Switzerland', lat: 47.37, lon: 8.54 },
  { city: 'Vienna', country: 'Austria', lat: 48.21, lon: 16.37 },
  { city: 'Prague', country: 'Czechia', lat: 50.08, lon: 14.44 },
  { city: 'Warsaw', country: 'Poland', lat: 52.23, lon: 21.01 },
  { city: 'Budapest', country: 'Hungary', lat: 47.5, lon: 19.04 },
  { city: 'Madrid', country: 'Spain', lat: 40.42, lon: -3.7 },
  { city: 'Barcelona', country: 'Spain', lat: 41.39, lon: 2.17 },
  { city: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 },
  { city: 'Rome', country: 'Italy', lat: 41.9, lon: 12.5 },
  { city: 'Milan', country: 'Italy', lat: 45.46, lon: 9.19 },
  { city: 'Athens', country: 'Greece', lat: 37.98, lon: 23.73 },
  { city: 'Copenhagen', country: 'Denmark', lat: 55.68, lon: 12.57 },
  { city: 'Stockholm', country: 'Sweden', lat: 59.33, lon: 18.07 },
  { city: 'Oslo', country: 'Norway', lat: 59.91, lon: 10.75 },
  { city: 'Helsinki', country: 'Finland', lat: 60.17, lon: 24.94 },
  { city: 'Istanbul', country: 'Turkey', lat: 41.01, lon: 28.98 },

  // ── Middle East & Africa ──
  { city: 'Dubai', country: 'United Arab Emirates', lat: 25.2, lon: 55.27 },
  { city: 'Doha', country: 'Qatar', lat: 25.29, lon: 51.53 },
  { city: 'Tel Aviv', country: 'Israel', lat: 32.09, lon: 34.78 },
  { city: 'Riyadh', country: 'Saudi Arabia', lat: 24.71, lon: 46.68 },
  { city: 'Cairo', country: 'Egypt', lat: 30.04, lon: 31.24 },
  { city: 'Casablanca', country: 'Morocco', lat: 33.57, lon: -7.59 },
  { city: 'Nairobi', country: 'Kenya', lat: -1.29, lon: 36.82 },
  { city: 'Lagos', country: 'Nigeria', lat: 6.52, lon: 3.38 },
  { city: 'Johannesburg', country: 'South Africa', lat: -26.2, lon: 28.05 },

  // ── Asia ──
  { city: 'Delhi', country: 'India', lat: 28.61, lon: 77.21 },
  { city: 'Mumbai', country: 'India', lat: 19.08, lon: 72.88 },
  { city: 'Bengaluru', country: 'India', lat: 12.97, lon: 77.59 },
  { city: 'Tokyo', country: 'Japan', lat: 35.68, lon: 139.69 },
  { city: 'Osaka', country: 'Japan', lat: 34.69, lon: 135.5 },
  { city: 'Seoul', country: 'South Korea', lat: 37.57, lon: 126.98 },
  { city: 'Beijing', country: 'China', lat: 39.9, lon: 116.41 },
  { city: 'Shanghai', country: 'China', lat: 31.23, lon: 121.47 },
  { city: 'Hong Kong', country: 'Hong Kong', lat: 22.32, lon: 114.17 },
  { city: 'Taipei', country: 'Taiwan', lat: 25.03, lon: 121.57 },
  { city: 'Singapore', country: 'Singapore', lat: 1.35, lon: 103.82 },
  { city: 'Bangkok', country: 'Thailand', lat: 13.76, lon: 100.5 },
  { city: 'Kuala Lumpur', country: 'Malaysia', lat: 3.14, lon: 101.69 },
  { city: 'Jakarta', country: 'Indonesia', lat: -6.21, lon: 106.85 },
  { city: 'Manila', country: 'Philippines', lat: 14.6, lon: 120.98 },
  { city: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.82, lon: 106.63 },
  { city: 'Hanoi', country: 'Vietnam', lat: 21.03, lon: 105.85 },

  // ── South America & Oceania ──
  { city: 'Sao Paulo', country: 'Brazil', lat: -23.55, lon: -46.63 },
  { city: 'Rio de Janeiro', country: 'Brazil', lat: -22.91, lon: -43.17 },
  { city: 'Buenos Aires', country: 'Argentina', lat: -34.6, lon: -58.38 },
  { city: 'Santiago', country: 'Chile', lat: -33.45, lon: -70.67 },
  { city: 'Lima', country: 'Peru', lat: -12.05, lon: -77.04 },
  { city: 'Bogota', country: 'Colombia', lat: 4.71, lon: -74.07 },
  { city: 'Sydney', country: 'Australia', lat: -33.87, lon: 151.21 },
  { city: 'Melbourne', country: 'Australia', lat: -37.81, lon: 144.96 },
  { city: 'Auckland', country: 'New Zealand', lat: -36.85, lon: 174.76 },
];

/** Great-circle distance in km between two lat/lon points. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export type NearestAirportCity = AirportCity & { distanceKm: number };

/** Closest major airport city to the given coordinates. */
export function findNearestAirportCity(
  lat: number,
  lon: number,
): NearestAirportCity | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: NearestAirportCity | null = null;
  for (const c of AIRPORT_CITIES) {
    const distanceKm = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || distanceKm < best.distanceKm) best = { ...c, distanceKm };
  }
  return best;
}

export type DetectResult =
  | { ok: true; city: NearestAirportCity }
  | { ok: false; reason: 'unsupported' | 'denied' | 'nomatch' };

/**
 * Browser-side detection: geolocation permission prompt → nearest airport
 * city. Never throws — every failure mode maps to a typed reason so both
 * planner modes can show the right fallback message. Coordinates never
 * leave the device (the lookup is the offline dataset above).
 */
export function detectNearestAirportCity(): Promise<DetectResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const city = findNearestAirportCity(pos.coords.latitude, pos.coords.longitude);
        resolve(city ? { ok: true, city } : { ok: false, reason: 'nomatch' });
      },
      () => resolve({ ok: false, reason: 'denied' }),
      { timeout: 8000, maximumAge: 300000 },
    );
  });
}
