#!/usr/bin/env tsx
/**
 * Build the checked-in location artifact.
 *
 *   npm run build:location-data              # uses the download cache
 *   npm run build:location-data -- --refresh # re-pull every upstream file
 *   npm run build:location-data -- --dry-run # measure, write nothing
 *
 * Emits, into src/data/generated/:
 *
 *   places.json   a LocationArtifact (src/services/location/types.ts)
 *   codes.json    ISO 3166-1 and USPS code lists, derived from source
 *
 * Both are CHECKED IN. The resolver loads them at boot; nothing downloads at
 * runtime. Re-run this when upstream moves and read the diff — `generatedAt`
 * and the upstream dataset dates are in the artifact so a stale build is
 * visible, and the places are id-sorted so the rest of the diff reads as an
 * airport changelog.
 *
 * ATTRIBUTION: GeoNames is CC BY 4.0 and attribution is REQUIRED. See
 * ATTRIBUTION.md at the repository root, which also records where it still has
 * to appear in the app.
 *
 * Phase 1 is dark: nothing here is wired into the running app.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LocationArtifact } from '../src/services/location/types';
import { build, SCHEMA_VERSION } from './location-data/build';
import {
  deriveCodeLists,
  parseCensusStates,
  parseCountryInfo,
} from './location-data/codes';
import {
  assertGeoNamesLicence,
  CENSUS_STATE_URL,
  fetchGeoNamesZip,
  fetchText,
  GEONAMES_DUMP_BASE,
  OURAIRPORTS_AIRPORTS_URL,
} from './location-data/sources';

const BACKEND_ROOT = join(__dirname, '..');
const OUT_DIR = join(BACKEND_ROOT, 'src', 'data', 'generated');
const CACHE_DIR = join(BACKEND_ROOT, '.location-data-cache');

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * ONE PLACE PER LINE.
 *
 * Fully pretty-printed, this file is 19.0 MiB and a one-airport change shows
 * up as a dozen moved lines. Fully compact, it is one 12.6 MiB line and the
 * diff is useless. One line per place, id-sorted, gives both: the artifact
 * diff reads as an airport changelog, which is half the reason the weights are
 * stored raw.
 */
function serialiseArtifact(artifact: LocationArtifact): string {
  const head = {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    sources: artifact.sources,
  };
  const lines = artifact.places.map((place) => JSON.stringify(place));
  return `${JSON.stringify(head, null, 1).replace(/\n}$/, '')},\n "places": [\n${lines.join(',\n')}\n ]\n}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const refresh = argv.includes('--refresh');
  const dryRun = argv.includes('--dry-run');
  const started = Date.now();

  console.log('location-data: fetching upstream sources');
  const [airportsCsv, cities, prominenceTier, midTier, admin1, countryInfo, readme, census] =
    await Promise.all([
      fetchText(OURAIRPORTS_AIRPORTS_URL, CACHE_DIR, { refresh }),
      fetchGeoNamesZip('cities1000.zip', 'cities1000.txt', CACHE_DIR, { refresh }),
      fetchGeoNamesZip('cities15000.zip', 'cities15000.txt', CACHE_DIR, { refresh }),
      fetchGeoNamesZip('cities5000.zip', 'cities5000.txt', CACHE_DIR, { refresh }),
      fetchText(`${GEONAMES_DUMP_BASE}admin1CodesASCII.txt`, CACHE_DIR, { refresh }),
      fetchText(`${GEONAMES_DUMP_BASE}countryInfo.txt`, CACHE_DIR, { refresh }),
      fetchText(`${GEONAMES_DUMP_BASE}readme.txt`, CACHE_DIR, { refresh }),
      fetchText(CENSUS_STATE_URL, CACHE_DIR, { refresh }),
    ]);

  const licence = assertGeoNamesLicence(readme.text);
  console.log(`location-data: GeoNames licence line -> ${licence}`);

  const downloadedBytes =
    airportsCsv.bytes +
    cities.bytes +
    prominenceTier.bytes +
    midTier.bytes +
    admin1.bytes +
    countryInfo.bytes +
    readme.bytes +
    census.bytes;
  console.log(`location-data: ${mib(downloadedBytes)} of upstream data`);

  const codeLists = deriveCodeLists(
    parseCountryInfo(countryInfo.text),
    parseCensusStates(census.text),
  );

  const generatedAt = new Date().toISOString();
  const { artifact, ranks, stats } = build({
    airportsCsv: airportsCsv.text,
    citiesTsv: cities.text,
    prominenceTierTsv: prominenceTier.text,
    midTierTsv: midTier.text,
    admin1Tsv: admin1.text,
    countryInfoTsv: countryInfo.text,
    sourceDates: {
      ourAirports: airportsCsv.upstreamDate,
      geoNames: cities.upstreamDate,
    },
    generatedAt,
  });

  const placesJson = serialiseArtifact(artifact);
  const codesJson = `${JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      sources: {
        iso3166Alpha2: `${GEONAMES_DUMP_BASE}countryInfo.txt (GeoNames, CC BY 4.0)`,
        uspsStateCodes: `${CENSUS_STATE_URL} (US Census Bureau, public domain)`,
      },
      ...codeLists,
    },
    null,
    1,
  )}\n`;
  const ranksJson = `${JSON.stringify(ranks, null, 1)}\n`;

  console.log('');
  console.log('── sources ─────────────────────────────────────────────');
  console.log(`  OurAirports airports.csv   ${airportsCsv.upstreamDate}  ${mib(airportsCsv.bytes)}`);
  console.log(`  GeoNames cities1000        ${cities.upstreamDate}  ${mib(cities.bytes)}`);
  console.log(`  GeoNames cities15000       ${prominenceTier.upstreamDate}`);
  console.log(`  GeoNames cities5000        ${midTier.upstreamDate}`);
  console.log(`  US Census state.txt        ${census.upstreamDate}`);
  console.log('');
  console.log('── airports ────────────────────────────────────────────');
  console.log(`  rows                       ${stats.airportRows}`);
  console.log(`  with an IATA code          ${stats.airportsWithIata}`);
  console.log(`  IATA + scheduled service   ${stats.scheduledIataAirports}`);
  console.log(`  municipality with ( ) or , ${stats.dirtyMunicipalityPct.toFixed(1)}%`);
  console.log(`  assigned a primary city    ${stats.assignedAirports}`);
  console.log(`  anchored to their own town ${stats.anchoredAirports} (extra, on top of assignment)`);
  console.log(
    `  no city within ${100} km       ${stats.orphanAirports} ` +
      `(${((100 * stats.orphanAirports) / stats.scheduledIataAirports).toFixed(1)}%) ` +
      `-> ${stats.syntheticPlaces} synthetic places`,
  );
  console.log('');
  console.log('── the trim rule (a union, never a threshold) ──────────');
  console.log(`  city rows read             ${stats.cityRowsRead}`);
  console.log(`  airport-serving cities     ${stats.airportServingCities}`);
  console.log(
    `  absent from cities15000    ${stats.droppedByProminenceFloor} ` +
      `(${stats.droppedByProminenceFloorPct.toFixed(1)}%)  <- what a floor would drop`,
  );
  console.log(`  absent from cities5000     ${stats.belowMidTier}`);
  console.log(`  cities included            ${stats.cityUniverse}`);
  console.log('');
  console.log('── artifact ────────────────────────────────────────────');
  console.log(`  places                     ${artifact.places.length}`);
  for (const [kind, count] of Object.entries(stats.places).sort()) {
    console.log(`    ${kind.padEnd(25)}${count}`);
  }
  console.log(`  curated metro groups       ${stats.metroGroupMembers} member cities`);
  console.log(`  curated places             ${stats.curatedPlaces}`);
  console.log(`  curated aliases            ${stats.curatedAliases}`);
  console.log(`  places.json                ${mib(Buffer.byteLength(placesJson))}`);
  console.log(`  codes.json                 ${mib(Buffer.byteLength(codesJson))}`);
  console.log(`  ISO 3166-1 alpha-2         ${codeLists.iso3166Alpha2.length}`);
  console.log(
    `  USPS state codes           ${codeLists.uspsStateCodes.length} ` +
      `(${codeLists.collidingCodes.length} collide with country codes, ` +
      `${codeLists.cleanStateCodes.length} clean)`,
  );

  if (dryRun) {
    console.log('\nlocation-data: --dry-run, nothing written');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'places.json'), placesJson);
  writeFileSync(join(OUT_DIR, 'codes.json'), codesJson);
  writeFileSync(join(OUT_DIR, 'airportRanks.json'), ranksJson);
  console.log('');
  console.log(`location-data: wrote ${join(OUT_DIR, 'places.json')} (${mib(statSync(join(OUT_DIR, 'places.json')).size)})`);
  console.log(`location-data: wrote ${join(OUT_DIR, 'codes.json')}`);
  console.log(`location-data: wrote ${join(OUT_DIR, 'airportRanks.json')}`);
  console.log(`location-data: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('\nlocation-data: BUILD FAILED');
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
