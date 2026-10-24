/**
 * Loader for the generated location artifact.
 *
 * The artifact is built by `scripts/build-location-data.ts` and CHECKED IN at
 * `src/data/generated/`. Nothing downloads at runtime.
 *
 * ── PACKAGING, VERIFIED BY EXPERIMENT. Do not "simplify" this. ──────────────
 *
 * `tsc` does not copy non-TS files:
 *
 *     import places from './generated/places.json'      -> emitted to dist, works
 *     fs.readFileSync(__dirname + '/places.json')       -> NOT emitted, ENOENT
 *
 * The `readFileSync` form works under `npm run dev` (tsx reads from src/) and
 * crashes the process at boot on Railway, where only `dist/` is deployed. The
 * import form is used here, and `npm run build` asserts the JSON landed in
 * `dist/` afterwards, because a packaging failure that only appears in
 * production is exactly the kind of bug a build step should catch.
 *
 * Phase 1 is dark: nothing in the running app imports this yet.
 */

import type { LocationArtifact, Place } from '../services/location/types';
import airportRanksJson from './generated/airportRanks.json';
import codesJson from './generated/codes.json';
import placesJson from './generated/places.json';

/**
 * ISO 3166-1 and USPS code lists, derived from source on every build rather
 * than hand-maintained. 31 of the 56 US state and territory codes are also
 * ISO 3166-1 country codes, and a list written from memory is how `Berlin, DE`
 * ends up pricing from Philadelphia.
 */
export type GeneratedCodeLists = {
  schemaVersion: number;
  generatedAt: string;
  sources: { iso3166Alpha2: string; uspsStateCodes: string };
  iso3166Alpha2: string[];
  uspsStateCodes: string[];
  collidingCodes: string[];
  cleanStateCodes: string[];
};

/**
 * What `airports[]` was actually ordered by.
 *
 * The contract asks for annual passengers descending, then distance. Annual
 * passenger counts are not openly licensed globally, so the passenger term is
 * the OurAirports `type` ordinal (large 3, medium 2, small 1) — measured
 * Spearman 0.578 against real route traffic, against 0.451 at best for
 * population. Three levels cannot separate LHR from LCY, so the multi-airport
 * metros carry a hand order in `scripts/location-data/curated.ts`.
 *
 * Emitted rather than left implicit so the sort invariant is testable across
 * the whole artifact instead of spot-checked.
 */
export type GeneratedAirportRanks = {
  schemaVersion: number;
  generatedAt: string;
  basis: 'ourairports-type-ordinal';
  ranks: Record<string, number>;
  /** Place id -> the hand-written prefix its `airports[]` leads with. */
  pinned: Record<string, string[]>;
};

/** The artifact, exactly as emitted. */
export const locationArtifact: LocationArtifact = placesJson as LocationArtifact;

export const locationCodeLists: GeneratedCodeLists = codesJson as GeneratedCodeLists;

export const locationAirportRanks: GeneratedAirportRanks =
  airportRanksJson as GeneratedAirportRanks;

export function allPlaces(): readonly Place[] {
  return locationArtifact.places;
}
