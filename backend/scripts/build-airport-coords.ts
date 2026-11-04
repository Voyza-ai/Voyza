/**
 * Writes src/data/generated/airportCoords.json: IATA -> [lat, lon] for every
 * scheduled-IATA airport in OurAirports (public domain — see
 * scripts/location-data/sources.ts), parsed exactly as build-location-data
 * parses it, so the code set matches airportNames.json.
 *
 * Used by GET /api/locations/hub: the schedule draws "Arrive at Rome → first
 * stop" from the real airport, offline, with no POI lookup.
 *
 *   npx tsx scripts/build-airport-coords.ts            (uses the download cache)
 *   npx tsx scripts/build-airport-coords.ts --refresh  (re-downloads)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAirports } from './location-data/build';
import { fetchText, OURAIRPORTS_AIRPORTS_URL } from './location-data/sources';

const BACKEND_ROOT = join(__dirname, '..');
const CACHE_DIR = join(BACKEND_ROOT, '.location-data-cache');
const OUT = join(BACKEND_ROOT, 'src', 'data', 'generated', 'airportCoords.json');

(async () => {
  const csv = await fetchText(OURAIRPORTS_AIRPORTS_URL, CACHE_DIR, { refresh: process.argv.includes('--refresh') });
  const { airports } = parseAirports(csv.text);
  const coords: Record<string, [number, number]> = {};
  for (const a of [...airports].sort((x, y) => x.iata.localeCompare(y.iata))) {
    coords[a.iata] = [Math.round(a.lat * 1e4) / 1e4, Math.round(a.lon * 1e4) / 1e4];
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { ourAirports: csv.upstreamDate },
    coords,
  });
  writeFileSync(OUT, body + '\n');
  console.log(`airport-coords: ${Object.keys(coords).length} airports, ${(body.length / 1024).toFixed(1)} KiB → ${OUT}`);
})();
