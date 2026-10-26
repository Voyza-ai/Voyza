/**
 * Every airport the curated layer PINS must still be a real, in-service
 * airport in the generated artifact.
 *
 * Why this exists. `scripts/location-data/curated.ts` hand-pins airports for
 * ~90 places where the derived order is wrong — metro grouping, airport order,
 * colloquial names. Those pins are the one part of the location data a human
 * wrote, so they are the one part that can rot: an airport closes, OurAirports
 * reclassifies it, and the pin silently names something that no longer flies.
 * An origin pinned to a closed field returns zero flights.
 *
 * What artifact membership PROVES. `parseAirports` keeps a row only when
 * `scheduled_service === 'yes'` and the type is not heliport, seaplane_base,
 * balloonport or closed (build.ts:355-356). Measured over the 9,054
 * IATA-coded rows in the dump: 4,921 fail the service flag and 125 more are a
 * heliport or seaplane base, leaving 4,008. So presence in the artifact means
 * OurAirports lists the code with scheduled service and a usable type — and
 * that is checkable against committed data on every change, where the build's
 * own validation (build.ts:703, :919) only runs when someone regenerates.
 *
 * It does NOT mean "not closed", though the type filter lists `closed`:
 * measured, NO `closed` row carries an IATA code at all (the dump's
 * IATA-coded types are only small/medium/large airport, heliport and seaplane
 * base). OurAirports retires the code when it marks a field closed, so that
 * clause never fires here. The service flag is what does the work.
 *
 * Which is exactly why the roadmap entry stays open: the dangerous case is an
 * airport closed in the WORLD that upstream still lists as in service, and it
 * keeps its code precisely because upstream has not marked it closed. The
 * known instance is DIA, the old Doha International — `large_airport`,
 * `scheduled_service=yes`, the same classification as Hamad, with nothing in
 * the row to separate them (compared field by field: same type, same
 * municipality, same flag; only a missing `home_link`, which thousands of
 * live airports also lack). DIA is therefore IN the artifact, 4.5 km from the
 * centre against Hamad's 7.9, so distance alone puts the closed field first.
 * The curated pin is the only thing holding the order, and the last test here
 * is what holds the pin.
 *
 * NEGATIVE CONTROL. The pin list is extracted from the curated source by
 * pattern, and a pattern that silently stops matching would make every
 * assertion below vacuous — this file would pass against zero pins. So the
 * first test asserts the extraction actually found a plausible number, and
 * `pinnedAirportCodes` throws rather than returning an empty set.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { allPlaces } from '../data/locationArtifact';
import { resolveOriginAirports } from '../services/location/originAirports';

const CURATED_SOURCE = join(__dirname, '../../scripts/location-data/curated.ts');

/**
 * Pulled from the source text rather than imported: `curated.ts` lives under
 * `scripts/`, outside this package's `rootDir`. Only `airports: [...]` arrays
 * are read — an earlier sweep that matched every quoted triple in the file
 * also caught `'ENG'`, which is England's GeoNames admin code, not an airport.
 */
function pinnedAirportCodes(): string[] {
  const src = readFileSync(CURATED_SOURCE, 'utf8');
  const codes = new Set<string>();
  for (const block of src.matchAll(/airports:\s*\[([^\]]*)\]/g)) {
    for (const code of block[1].match(/[A-Z]{3}/g) ?? []) codes.add(code);
  }
  if (codes.size === 0) {
    throw new Error(
      `No airport pins found in ${CURATED_SOURCE}. The extraction pattern has ` +
        'drifted from the file format, and every assertion in this suite would ' +
        'otherwise pass against nothing.',
    );
  }
  return [...codes].sort();
}

/** Every IATA code the committed artifact attaches to any place. */
function airportsInArtifact(): Set<string> {
  const codes = new Set<string>();
  for (const place of allPlaces()) {
    for (const airport of place.airports) codes.add(airport.iata);
  }
  return codes;
}

describe('curated airport pins are still in service', () => {
  it('finds the pins at all', () => {
    // Guards every other test in this file against passing vacuously.
    const pins = pinnedAirportCodes();
    expect(pins.length).toBeGreaterThanOrEqual(80);
    // Spot-check that what came out looks like airports rather than, say,
    // admin codes: three pins no plausible edit would remove together.
    expect(pins).toEqual(expect.arrayContaining(['JFK', 'LHR', 'DOH']));
  });

  it('throws rather than returning nothing when the pattern drifts', () => {
    // Proves the guard above is real: the same extraction over a file with no
    // airport arrays raises instead of quietly yielding an empty set.
    const extractFrom = (text: string) => {
      const codes = new Set<string>();
      for (const block of text.matchAll(/airports:\s*\[([^\]]*)\]/g)) {
        for (const code of block[1].match(/[A-Z]{3}/g) ?? []) codes.add(code);
      }
      if (codes.size === 0) throw new Error('no pins');
      return codes;
    };
    expect(() => extractFrom('export const NOTHING = [];')).toThrow('no pins');
  });

  it('every pinned airport is a scheduled, non-closed airport in the artifact', () => {
    const inArtifact = airportsInArtifact();
    const missing = pinnedAirportCodes().filter((code) => !inArtifact.has(code));

    // A code drops out of the artifact when OurAirports marks it closed, pulls
    // its scheduled service, or retires the code. Any of those makes the pin a
    // dead end, so the message names them for whoever has to fix it.
    expect(missing).toEqual([]);
  });

  it('keeps Doha on Hamad, not the old Doha International', () => {
    // The one case where upstream data is known to be wrong: DIA is the
    // decommissioned Doha International, still filed as a large airport with
    // scheduled service, and it sits 4.5 km from the city centre against
    // Hamad's 7.9 — so the derived order puts the closed field first. The pin
    // is the only thing holding this, and nothing above would catch its loss,
    // because DIA is in the artifact too.
    const resolved = resolveOriginAirports('Doha', {});
    expect(resolved.airports[0]).toBe('DOH');
  });
});
