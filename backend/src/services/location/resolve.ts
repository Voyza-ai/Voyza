/**
 * The resolution pipeline.
 *
 *   1. Normalise to a key set.
 *   2. Split on commas.
 *   3. Qualifier pass, RIGHT TO LEFT, against `qualifier` only.
 *   4. Exact lookup of the head, narrowed by any qualifier.
 *   5. Prune candidates with no scheduled airport within range.
 *   6. Fuzzy, only on an exact miss, within the same narrowing.
 *   7. Decide.
 *
 * Step 3 is the most valuable rule in the file and it is a restriction, not an
 * addition: only a country/state/region key may act as a qualifier. That is
 * what stops `Paris, Texas` → CDG, `Berlin, DE` → Delaware and
 * `Baton Rouge, LA` → Los Angeles.
 *
 * Deciding (step 7) is an ORDERED RULE, not a threshold, and that was settled
 * before any of this was written — see `nearTieEpsilon` in `options.ts` for the
 * measurements that killed the scalar version.
 *
 * Everything here is a pure function of (input, context, index, options). No
 * clock, no network, no module state — so the whole thing is testable against a
 * fixture, which is the point, because the real artifact does not exist yet.
 */

import type {
  Candidate,
  Place,
  ResolveContext,
  Resolution,
  ResolutionReason,
} from './types';
import type { BuiltIndex } from './buildIndex';
import { DEFAULT_OPTIONS, fuzzyDistanceFor, type ResolverOptions } from './options';
import { keysForQuery, splitSegments } from './normalize';
import { centroidOf, haversineKm, type LatLon } from './geo';
import { prominenceOf } from './prominence';

/** A comma segment that was read as a qualifier, with every reading it has. */
type QualifierSegment = {
  raw: string;
  /** OR within a segment: `DE` is Germany or Delaware until a head decides. */
  places: Place[];
};

type HeadSplit = {
  head: string;
  qualifiers: QualifierSegment[];
};

/**
 * Right to left, stopping at the first segment that is not a qualifier key.
 * The leftmost remaining segment is the head.
 *
 * Never consumes the last remaining segment, so a bare `France` or `NY` still
 * resolves as a place (the owner's rule: a bare state gives every airport that
 * serves it).
 *
 * Segments left over between the head and the qualifiers are ignored on
 * purpose: `Paris, 75001, France` must still be Paris, and a postcode will
 * never be in the qualifier index. Ignoring them can only produce a coarser
 * real place, never a wrong continent, because the qualifier guard still
 * applies to every segment that IS one.
 */
function splitHead(segments: string[], index: BuiltIndex): HeadSplit {
  const qualifiers: QualifierSegment[] = [];
  let end = segments.length;

  while (end > 1) {
    const raw = segments[end - 1];
    const places = qualifierPlaces(raw, index);
    if (places.length === 0) break;
    qualifiers.unshift({ raw, places });
    end -= 1;
  }

  return { head: segments[0], qualifiers };
}

function qualifierPlaces(raw: string, index: BuiltIndex): Place[] {
  const out: Place[] = [];
  for (const key of keysForQuery(raw)) {
    for (const id of index.qualifier.get(key) ?? []) {
      const place = index.byId.get(id);
      if (place && !out.includes(place)) out.push(place);
    }
  }
  return out;
}

/**
 * Does this qualifier reading contain that candidate?
 *
 * The admin comparison is deliberately tolerant: the contract fixes
 * `admin: string | null` but does not say that a state place's `admin` is
 * spelled the same way as the code its cities carry. So a state matches when
 * the codes agree, when the candidate's admin spells out the state's name, or
 * when the candidate IS the state.
 */
function qualifierContains(qualifier: Place, candidate: Place): boolean {
  if (qualifier.id === candidate.id) return true;
  if (qualifier.kind === 'country') {
    return candidate.country.toUpperCase() === qualifier.country.toUpperCase();
  }
  if (qualifier.kind !== 'state' && qualifier.kind !== 'region') return false;
  if (candidate.country.toUpperCase() !== qualifier.country.toUpperCase()) return false;
  if (!candidate.admin) return false;

  const candidateAdmin = candidate.admin.toUpperCase();
  if (qualifier.admin && candidateAdmin === qualifier.admin.toUpperCase()) return true;
  return keysForQuery(qualifier.name).includes(candidateAdmin.toLowerCase());
}

/** AND across segments, OR within one. `Paris, Texas, France` matches nothing. */
function narrow(candidates: Place[], qualifiers: QualifierSegment[]): Place[] {
  if (qualifiers.length === 0) return candidates;
  return candidates.filter((candidate) =>
    qualifiers.every((segment) => segment.places.some((q) => qualifierContains(q, candidate))),
  );
}

/**
 * Step 5. A narrowing, not a filter — see `maxAirportKm`.
 *
 * Range is measured from the place's centre, which is only meaningful for a
 * point-like place. A state or a country is not point-like: the centre of the
 * United States is 300 km from anything, and pruning on that would answer
 * `Georgia` with the US state every time because the country's centroid is far
 * from Tbilisi. So for a region, state or country, "has any airport at all" is
 * the test.
 */
function hasAirportInRange(place: Place, options: ResolverOptions): boolean {
  if (place.kind === 'city' || place.kind === 'metro') {
    return place.airports.some((airport) => airport.km <= options.maxAirportKm);
  }
  return place.airports.length > 0;
}

function prune(candidates: Place[], options: ResolverOptions): Place[] {
  if (candidates.length < 2) return candidates;
  const kept = candidates.filter((place) => hasAirportInRange(place, options));
  return kept.length > 0 ? kept : candidates;
}

function placesForKeys(keys: string[], index: BuiltIndex): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const id of index.exact.get(key) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const place = index.byId.get(id);
      if (place) out.push(place);
    }
  }
  return out;
}

function label(place: Place, index: BuiltIndex, reference: LatLon | null): string {
  const parts: string[] = [place.name];
  // A part that repeats the name adds nothing: the state of Georgia should
  // read "Georgia, United States", not "Georgia, Georgia, United States", and
  // the country should read "Georgia".
  const push = (part: string | undefined | null): void => {
    if (part && !parts.includes(part)) parts.push(part);
  };
  if (place.admin) {
    push(
      index.adminNames.get(`${place.country.toUpperCase()}:${place.admin.toUpperCase()}`) ??
        place.admin,
    );
  }
  push(index.countryNames.get(place.country.toUpperCase()) ?? place.country);

  let text = parts.join(', ');
  // `Candidate` has no distance field, so the distance the doc asks us to show
  // rides in the label. Flagged for the owner rather than changing the shared
  // contract, which a parallel agent is building against.
  if (reference) text += ` · ${Math.round(haversineKm(reference, place))} km away`;
  return text;
}

function candidateOf(
  place: Place,
  index: BuiltIndex,
  reference: LatLon | null,
  editDistance?: number,
): Candidate {
  const candidate: Candidate = {
    place,
    label: label(place, index, reference),
    airports: place.airports,
  };
  if (editDistance !== undefined) candidate.editDistance = editDistance;
  return candidate;
}

function resolved(place: Place, via: ResolutionReason): Resolution {
  return { status: 'resolved', place, airports: place.airports, via };
}

function scoreOf(place: Place, index: BuiltIndex): number {
  return index.prominence.get(place.id) ?? prominenceOf(place);
}

function byProminence(places: Place[], index: BuiltIndex): Place[] {
  return [...places].sort(
    (a, b) => scoreOf(b, index) - scoreOf(a, index) || a.id.localeCompare(b.id),
  );
}

/**
 * Nearest candidate, but only when it is clearly nearest. Returns null when no
 * candidate dominates, which drops the decision through to the next rule
 * rather than letting a 5 km difference pick a country.
 */
function dominantNearest(
  candidates: Place[],
  reference: LatLon,
  options: ResolverOptions,
  maxNearestKm = Infinity,
): Place | null {
  const ranked = candidates
    .map((place) => ({ place, km: haversineKm(reference, place) }))
    .sort((a, b) => a.km - b.km);
  if (ranked.length === 0) return null;
  if (ranked[0].km > maxNearestKm) return null;
  if (ranked.length === 1) return ranked[0].place;

  const [first, second] = ranked;
  const clearRatio = second.km >= first.km * options.locationDominanceRatio;
  const clearGap = second.km - first.km >= options.locationDominanceKm;
  return clearRatio && clearGap ? first.place : null;
}

/**
 * Centroid of the trip's destinations, resolved internally.
 *
 * `tripDestinationNames` is names, not places, because the store holds plain
 * strings. Failures are tolerated by design: a destination that comes back
 * `ambiguous` still contributes its best candidate, because a centroid wants a
 * rough position, not a committed answer, and `Rome` is ambiguous (Italy and
 * Georgia) in exactly the case this signal exists to serve.
 */
function tripCentroid(
  names: string[] | undefined,
  index: BuiltIndex,
  options: ResolverOptions,
): LatLon | null {
  if (!names || names.length === 0) return null;
  const points: LatLon[] = [];
  for (const name of names) {
    // Depth 1: no trip context inside, so this cannot recurse.
    const inner = resolveAt(name, {}, index, options, 1);
    if (inner.status === 'resolved') points.push(inner.place);
    else if (inner.status === 'ambiguous' && inner.candidates.length > 0) {
      points.push(inner.candidates[0].place);
    }
  }
  return centroidOf(points);
}

/**
 * Group by country, then by admin region, cap both, best-first.
 *
 * Grouping is what makes thirty Springfields answerable: a flat list of thirty
 * is not a question anyone can answer, and the cap without the grouping would
 * silently drop whole countries.
 */
function groupCandidates(
  places: Place[],
  index: BuiltIndex,
  reference: LatLon | null,
  options: ResolverOptions,
): Candidate[] {
  const ranked = byProminence(places, index);

  const byCountry = new Map<string, Place[]>();
  for (const place of ranked) {
    const key = place.country.toUpperCase();
    const bucket = byCountry.get(key);
    if (bucket) bucket.push(place);
    else byCountry.set(key, [place]);
  }

  const out: Place[] = [];
  // Countries keep the order of their best candidate, which `ranked` already
  // fixed, so Map insertion order is the ranking.
  for (const group of byCountry.values()) {
    const perAdmin = new Map<string, number>();
    for (const place of group) {
      const adminKey = place.admin?.toUpperCase() ?? '';
      const used = perAdmin.get(adminKey) ?? 0;
      if (used >= options.maxPerAdminGroup) continue;
      perAdmin.set(adminKey, used + 1);
      out.push(place);
    }
  }

  return out.slice(0, options.maxCandidates).map((p) => candidateOf(p, index, reference));
}

/**
 * Step 7, in strict order:
 *
 *   1. an explicit qualifier pins the answer
 *   2. the traveller's own coordinates decide
 *   3. the trip's centroid decides
 *   4. candidates spanning more than one country ALWAYS ask
 *   5. a scalar margin, only for a same-country near-tie
 *
 * Rule 4 before rule 5 is the whole design: bare `Paris` asks because it spans
 * France and the United States, not because its prominence gap is small — it
 * is in fact the widest gap in the measured set.
 *
 * `ResolveContext.userCountry` is deliberately NOT a rule here. A traveller in
 * the United States typing `Paris` means France far more often than Texas, so
 * country-of-origin would invert the single most valuable guard in the file
 * while looking like a refinement.
 */
function decide(
  candidates: Place[],
  context: ResolveContext,
  index: BuiltIndex,
  options: ResolverOptions,
  qualified: boolean,
  depth: number,
): Resolution {
  if (candidates.length === 1) {
    return resolved(candidates[0], qualified ? 'qualifier-pinned' : 'exact-unique');
  }

  if (context.userLatLon) {
    const winner = dominantNearest(candidates, context.userLatLon, options, options.userLocalKm);
    if (winner) return resolved(winner, 'user-location');
  }

  const centroid = depth === 0 ? tripCentroid(context.tripDestinationNames, index, options) : null;
  if (centroid) {
    const winner = dominantNearest(candidates, centroid, options);
    if (winner) return resolved(winner, 'trip-context');
  }

  const reference = context.userLatLon ?? centroid ?? null;
  const countries = new Set(candidates.map((p) => p.country.toUpperCase()));
  if (countries.size > 1) {
    return {
      status: 'ambiguous',
      candidates: groupCandidates(candidates, index, reference, options),
      reason: 'multi-country',
    };
  }

  const ranked = byProminence(candidates, index);
  const top = scoreOf(ranked[0], index);
  const withinMargin = ranked.filter((p) => scoreOf(p, index) >= top - options.nearTieEpsilon);
  if (withinMargin.length === 1) return resolved(ranked[0], 'prominence');

  return {
    status: 'ambiguous',
    candidates: groupCandidates(ranked, index, reference, options),
    reason: 'near-tie',
  };
}

/** Step 6. Fuzzy PROPOSES; it never substitutes, so this is never `resolved`. */
function suggest(
  headKeys: string[],
  qualifiers: QualifierSegment[],
  index: BuiltIndex,
  reference: LatLon | null,
  options: ResolverOptions,
): Resolution {
  const hits = new Map<string, number>(); // place id -> best edit distance
  for (const key of headKeys) {
    for (const hit of index.fuzzy.search(key, fuzzyDistanceFor(key.length), options.maxSuggestions * 4)) {
      for (const id of index.exact.get(hit.key) ?? []) {
        const best = hits.get(id);
        if (best === undefined || hit.distance < best) hits.set(id, hit.distance);
      }
    }
  }

  const places: Place[] = [];
  for (const id of hits.keys()) {
    const place = index.byId.get(id);
    if (place) places.push(place);
  }

  const narrowed = narrow(places, qualifiers);
  const ranked = byProminence(narrowed, index).sort((a, b) => {
    const da = hits.get(a.id) ?? 99;
    const db = hits.get(b.id) ?? 99;
    return da - db || scoreOf(b, index) - scoreOf(a, index);
  });

  return {
    status: 'unknown',
    suggestions: ranked
      .slice(0, options.maxSuggestions)
      .map((place) => candidateOf(place, index, reference, hits.get(place.id))),
  };
}

const IATA_SHAPE = /^[A-Za-z]{3}$/;

function iataPlace(head: string, index: BuiltIndex): Place | null {
  if (!IATA_SHAPE.test(head)) return null;
  const id = index.iata.get(head.toUpperCase());
  return id ? index.byId.get(id) ?? null : null;
}

function resolveAt(
  rawInput: string,
  context: ResolveContext,
  index: BuiltIndex,
  options: ResolverOptions,
  depth: number,
): Resolution {
  const input = (rawInput ?? '').slice(0, options.maxInputLength).trim();
  const segments = splitSegments(input);
  if (segments.length === 0) return { status: 'unknown', suggestions: [] };

  const { head, qualifiers } = splitHead(segments, index);
  const headKeys = keysForQuery(head);

  // Script guard. No Latin letters means no key, which means `exact` cannot
  // hit, which means fuzzy would propose "Ba, Ho, Li" for 東京. It gets nothing.
  if (headKeys.length === 0) return { status: 'unknown', suggestions: [] };

  const reference = context.userLatLon ?? null;
  const iataHit = iataPlace(head, index);
  const iataAllowed = iataHit !== null && narrow([iataHit], qualifiers).length === 1;

  // An all-caps three-letter head is a code, not a town: `ORD` is O'Hare while
  // `Ord` is Ord, Nebraska. Mixed case falls through to `exact` first.
  if (iataAllowed && head === head.toUpperCase()) return resolved(iataHit, 'iata-code');

  const exactHits = placesForKeys(headKeys, index);
  if (exactHits.length === 0) {
    if (iataAllowed) return resolved(iataHit, 'iata-code');
    return suggest(headKeys, qualifiers, index, reference, options);
  }

  const narrowed = narrow(exactHits, qualifiers);
  if (narrowed.length === 0) {
    if (iataAllowed) return resolved(iataHit, 'iata-code');
    // The place exists but not where the traveller said it does. Offering the
    // unqualified matches is a question; applying one would be a guess.
    return {
      status: 'unknown',
      suggestions: byProminence(prune(exactHits, options), index)
        .slice(0, options.maxSuggestions)
        .map((place) => candidateOf(place, index, reference)),
    };
  }

  const pruned = prune(narrowed, options);
  return decide(pruned, context, index, options, qualifiers.length > 0, depth);
}

/**
 * Turn free text into airports, or into a question. Pure.
 *
 * Three results, two of which are questions: a silent empty and a confident
 * wrong are both bugs. The system is allowed not to know; it is not allowed to
 * pretend.
 */
export function resolve(
  input: string,
  context: ResolveContext,
  index: BuiltIndex,
  options: Partial<ResolverOptions> = {},
): Resolution {
  return resolveAt(input, context ?? {}, index, { ...DEFAULT_OPTIONS, ...options }, 0);
}

/** Convenience for callers that hold one index for the process lifetime. */
export function createResolver(index: BuiltIndex, options: Partial<ResolverOptions> = {}) {
  const merged: ResolverOptions = { ...DEFAULT_OPTIONS, ...options };
  return {
    index,
    options: merged,
    resolve: (input: string, context: ResolveContext = {}): Resolution =>
      resolveAt(input, context, index, merged, 0),
  };
}
