/**
 * The resolver, in the shape the origin-airport callers actually need.
 *
 * `data/originAirports.ts` answers `string -> IATA[]` from a hand-written
 * table of 68 keys. This answers the same question from the generated
 * artifact, and it is the adapter rather than the resolver because the two
 * disagree about what an answer IS:
 *
 *   - the table returns `[]` for anything it does not know, and `[]` is also
 *     what it returns for a place it deliberately refuses to guess at. The
 *     caller cannot tell those apart.
 *   - the resolver distinguishes "no idea" from "more than one real reading",
 *     and the second one is a question.
 *
 * `optimizer.ts` cannot ask a question mid-run — it is already spending money
 * on Duffel by then. So the contract here is the one the architecture doc
 * settled on: **always return a best-effort list, and say when it was a
 * guess.** Never throw, never return nothing when something real was found.
 *
 * The caller that CAN ask (the planner conversation) reads
 * `needsClarification` and asks. The callers that cannot carry it to the trip,
 * so the question can be asked later instead of never.
 */

import type { Candidate, Place, Resolution, ResolveContext } from './types';
import { buildIndex, type BuiltIndex } from './buildIndex';
import { resolve } from './resolve';
import { locationArtifact } from '../../data/locationArtifact';

/** Matches the cap the hand-written table has always applied. */
export const DEFAULT_MAX_AIRPORTS = 3;

export type OriginCandidate = {
  /** Stable place id, so a choice can be persisted rather than re-derived. */
  placeId: string;
  /** "Paris, Île-de-France, France" — enough to tell two readings apart. */
  label: string;
  airports: string[];
  /** Km from the traveller or the trip, when either was known. */
  distanceKm?: number;
};

export type OriginResolution = {
  /**
   * IATA codes to price from, best-first, capped.
   *
   * `airports[0]` is load-bearing: `estimateHomeLegCost` prices every route
   * permutation from it alone, so the order is the artifact's (passenger
   * volume, then distance) and not alphabetical.
   */
  airports: string[];
  /**
   * The place this came from, or null when nothing was found.
   *
   * Worth persisting on the trip. Today `trips` holds `origin_city` and
   * `origin_airports` but no id, so every caller re-derives and may re-derive
   * differently; an id makes the resolution happen once.
   */
  placeId: string | null;
  /**
   * Set when `airports` is a best guess rather than an answer.
   *
   * Present means: we found more than one real reading and picked the most
   * prominent so the run could continue. A caller that can ask, should.
   */
  needsClarification?: {
    reason: 'multi-country' | 'near-tie' | 'not-found';
    /** Best-first, already capped by the resolver. Empty for 'not-found'. */
    candidates: OriginCandidate[];
  };
};

const EMPTY: OriginResolution = { airports: [], placeId: null };

/**
 * One index per process, built on first use.
 *
 * Lazy rather than at import time so a process that never resolves a location
 * — a worker, a migration, most of the test suite — does not pay the build.
 */
let cachedIndex: BuiltIndex | null = null;

export function originIndex(): BuiltIndex {
  if (!cachedIndex) cachedIndex = buildIndex(locationArtifact);
  return cachedIndex;
}

/** Test seam. Also lets a caller share an index it already built. */
export function setOriginIndex(index: BuiltIndex | null): void {
  cachedIndex = index;
}

function airportsOf(place: Place, max: number): string[] {
  return place.airports.slice(0, max).map((airport) => airport.iata);
}

function candidateOf(candidate: Candidate, max: number): OriginCandidate {
  const out: OriginCandidate = {
    placeId: candidate.place.id,
    label: candidate.label,
    airports: airportsOf(candidate.place, max),
  };
  if (candidate.distanceKm !== undefined) out.distanceKm = candidate.distanceKm;
  return out;
}

/**
 * One card per READING, not one per GeoNames row.
 *
 * `San Juan` returned eight candidates of which four were doubles — "San Juan,
 * Argentina" twice and "San Juan, Puerto Rico" twice — because the upstream
 * dump carries the same city as two rows. 110 city groups share a
 * name+country+admin that way, 114 rows in all; the clear ones are identical
 * down to the population (San Juan PR is 418,140 on both).
 *
 * Collapsing on the LABEL rather than on place identity is deliberate. The
 * label is the entire basis on which a traveller chooses, so two candidates
 * printing the same string are the same choice to them whether or not the rows
 * are truly one place — offering both is asking a question with two identical
 * answers. Keeping the FIRST is what makes it safe: candidates arrive ranked,
 * so the survivor is the more prominent row, and where the rows differ it is
 * the better-attached one (San Juan PR's leading row carries eight airports
 * against the other's six).
 *
 * Deliberately not fixed in the pipeline: deduping there would need a rule for
 * which row wins, and two cities CAN legitimately share a name inside one
 * admin region with different populations (Changzhi, CN: 1,214,940 and
 * 699,514). Here the ranking has already made that call.
 */
function dedupeByLabel(candidates: OriginCandidate[]): OriginCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Collapse a `Resolution` into the non-asking contract.
 *
 * Exported so the shadow comparison measures exactly what a caller would be
 * served, rather than its own reading of the same `Resolution`.
 */
export function fromResolution(result: Resolution, max = DEFAULT_MAX_AIRPORTS): OriginResolution {
  if (result.status === 'resolved') {
    return {
      airports: airportsOf(result.place, max),
      placeId: result.place.id,
    };
  }

  if (result.status === 'ambiguous') {
    // Best effort is the resolver's own top candidate: the list is already
    // ranked, grouped and pruned, so "the first one" is the most prominent
    // real reading rather than whatever the data happened to emit first.
    const [best] = result.candidates;
    if (!best) return EMPTY;
    return {
      airports: airportsOf(best.place, max),
      placeId: best.place.id,
      needsClarification: {
        reason: result.reason,
        candidates: dedupeByLabel(result.candidates.map((candidate) => candidateOf(candidate, max))),
      },
    };
  }

  // `unknown`. Suggestions are fuzzy near-misses and are NEVER applied — a
  // typo must not become a booked flight. So there is no best effort here,
  // and the caller gets the same empty list the old table would have given,
  // plus the suggestions to ask with.
  return {
    airports: [],
    placeId: null,
    needsClarification: {
      reason: 'not-found',
      candidates: dedupeByLabel(result.suggestions.map((candidate) => candidateOf(candidate, max))),
    },
  };
}

/**
 * Resolver-backed replacement for `getOriginAirports`.
 *
 * `context` is what lifts this above the table it replaces: the same string
 * resolves differently for a traveller in Manhattan than for one in Perth,
 * and a trip already naming Florence and Venice says which Rome is meant.
 * Callers that have none pass nothing and get the prominence answer.
 */
export function resolveOriginAirports(
  cityName: string | null | undefined,
  context: ResolveContext = {},
  max = DEFAULT_MAX_AIRPORTS,
): OriginResolution {
  if (!cityName || !cityName.trim()) return EMPTY;
  return fromResolution(resolve(cityName, context, originIndex()), max);
}
