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
  KeyMatch,
  KeyTier,
  Place,
  PlaceKind,
  ResolveContext,
  Resolution,
  ResolutionReason,
} from './types';
import { keyTierRank, type BuiltIndex } from './buildIndex';
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
 * `Washington State`, `New York State` — a trailing kind word.
 *
 * The word "state" is the traveller telling us which KIND of place they mean,
 * and it is the only way to say "the state, not the city of the same name".
 * Without it, `Washington State` misses `exact` outright and comes back
 * unknown: the state's name is "Washington", and nothing is indexed under
 * "washington state". Measured against the table this replaces, which keys
 * both strings by hand, those were the only two inputs where the resolver
 * returned NOTHING and the table returned an answer — SEA, and JFK/LGA/EWR.
 *
 * Stripping the suffix unconditionally would be the bug the old table's own
 * comment warns about: `washington state` stripped to `washington` is
 * Washington DC here, and would price a Seattle traveller out of Dulles. Two
 * things prevent that. It runs ONLY after `exact` has missed, and it keeps
 * only candidates of the named kind — so the answer is the state or nothing.
 *
 * There is deliberately NO ` city` entry. "City" is part of real names
 * — Mexico City, Kansas City, Salt Lake City, Jersey City — which all hit
 * `exact` and never reach this function. Adding it would turn `Kansas City`
 * into a search for a city called "Kansas".
 */
const ADMIN_SUFFIXES = [' state', ' province'] as const;

/**
 * Both suffixes mean the same thing: the administrative unit, not a city. They
 * accept `state` AND `region` because the model has one kind per
 * administrative level and only the 51 US states are `state` — a Canadian
 * province and a German Land are both `region`, so matching `state` alone
 * would answer `Ontario Province` with nothing.
 */
const ADMIN_KINDS: ReadonlySet<PlaceKind> = new Set<PlaceKind>(['state', 'region']);

function adminSuffixSplit(head: string): string | null {
  const lower = head.toLowerCase();
  for (const suffix of ADMIN_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return head.slice(0, head.length - suffix.length).trim();
    }
  }
  return null;
}

/**
 * Peel a space-separated qualifier off the end of a head, LONGEST FIRST.
 *
 * Word-by-word from the right is the obvious way and it is wrong twice:
 *
 *   `baton rouge la`    -> peels `la`, then stops at `rouge`, leaving the head
 *                          as `baton` and finding nothing. Measured; it
 *                          returned unknown for a city the table answers.
 *   `newark new jersey` -> peels `jersey` (a country, JE), stops at `new`,
 *                          and leaves the head as `newark new`.
 *
 * So every split point is tried and the longest qualifier wins: `new jersey`
 * beats `jersey`, and the head keeps all its own words. Returns null when no
 * trailing run of words is a qualifier at all, which is the common case.
 *
 * The last word is never consumed alone — a bare `france` stays a place.
 */
function spacedQualifierSplit(
  head: string,
  index: BuiltIndex,
): { head: string; qualifiers: QualifierSegment[] } | null {
  const words = head.split(' ').filter((w) => w.length > 0);
  if (words.length < 2) return null;

  for (let i = 1; i < words.length; i += 1) {
    const raw = words.slice(i).join(' ');
    const places = qualifierPlaces(raw, index);
    if (places.length === 0) continue;
    return { head: words.slice(0, i).join(' '), qualifiers: [{ raw, places }] };
  }
  return null;
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

/**
 * Keep only the best-attested matches, and report which tier won.
 *
 * This is the single most valuable narrowing in the file after the qualifier
 * guard, and it is a correction to measured behaviour rather than a
 * refinement. Against the real artifact, before it existed:
 *
 *   Venice     -> Dayton, Ohio          (top candidate!)
 *   Rome       -> offered Lomé, Togo
 *   Washington -> offered Reisterstown MD, South River NJ, Piqua OH, Macomb IL
 *   la         -> offered Laos and Lautém, Timor-Leste
 *
 * Every one of those is a GeoNames alternate name competing on equal footing
 * with a city's own name. They are not equal: a place's own name is a fact
 * about the place, an alternate name is a crowd-sourced annotation, and the
 * crowd has written "venice" on Dayton. Keeping only the best tier present
 * removed all four without a single per-city exception.
 *
 * The cost is real and worth stating: a place reachable ONLY by a dataset
 * alias now loses to any place matching the same string canonically. That is
 * the intended trade — it is the same direction as the qualifier guard, and it
 * fails toward a question rather than toward Togo.
 */
function narrowToBestTier(matches: KeyMatch[]): { matches: KeyMatch[]; tier: KeyTier | null } {
  if (matches.length === 0) return { matches, tier: null };
  let best = matches[0].tier;
  for (const match of matches) {
    if (keyTierRank(match.tier) > keyTierRank(best)) best = match.tier;
  }
  return { matches: matches.filter((m) => m.tier === best), tier: best };
}

function matchesForKeys(keys: string[], index: BuiltIndex): KeyMatch[] {
  const out: KeyMatch[] = [];
  const seen = new Map<string, KeyMatch>();
  for (const key of keys) {
    for (const match of index.exact.get(key) ?? []) {
      const held = seen.get(match.id);
      if (!held) {
        const copy = { id: match.id, tier: match.tier };
        seen.set(match.id, copy);
        out.push(copy);
        continue;
      }
      // The same place reached under two keys of the query keeps its better
      // reading: `Köln` yields both `koln` and `koeln` and only one of them
      // need be the canonical spelling.
      if (keyTierRank(match.tier) > keyTierRank(held.tier)) held.tier = match.tier;
    }
  }
  return out;
}

function placesOf(matches: KeyMatch[], index: BuiltIndex): Place[] {
  const out: Place[] = [];
  for (const match of matches) {
    const place = index.byId.get(match.id);
    if (place) out.push(place);
  }
  return out;
}

function placesForKeys(keys: string[], index: BuiltIndex): Place[] {
  return placesOf(narrowToBestTier(matchesForKeys(keys, index)).matches, index);
}

function label(place: Place, index: BuiltIndex): string {
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

  return parts.join(', ');
}

function candidateOf(
  place: Place,
  index: BuiltIndex,
  reference: LatLon | null,
  editDistance?: number,
): Candidate {
  const candidate: Candidate = {
    place,
    label: label(place, index),
    airports: place.airports,
  };
  // Distance is a number on the candidate, not text inside its label: the UI
  // formats and sorts by it. Earlier this rode in `label` only because the
  // contract was being built in parallel and could not be changed.
  if (reference) candidate.distanceKm = Math.round(haversineKm(reference, place));
  if (editDistance !== undefined) candidate.editDistance = editDistance;
  return candidate;
}

/**
 * A resolution must carry at least one airport.
 *
 * The pipeline's built artifact holds 2,470 places with an empty `airports[]`,
 * kept so they can act as qualifiers. Answering `resolved` with an empty list
 * would put the original bug back at the call site: `estimateHomeLegCost`
 * prices from `airports[0]`, so an empty list is a trip with no home flight
 * and no explanation — failure mode 3, reintroduced through the new system.
 *
 * So a place with NO airports at all comes back as a question, with itself as
 * the suggestion, which a non-asking caller sees as "not resolved" and falls
 * back on.
 *
 * A place whose airports are merely FAR is a different case and resolves
 * normally: the owner's rule is that a 2-hour drive is acceptable as long as
 * it is shown, and distance is on every airport in every result. Range is for
 * choosing between candidates, not for hiding the only answer there is.
 */
function answer(
  place: Place,
  via: ResolutionReason,
  index: BuiltIndex,
  reference: LatLon | null,
): Resolution {
  if (place.airports.length === 0) {
    return { status: 'unknown', suggestions: [candidateOf(place, index, reference)] };
  }
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
  matchTier: KeyTier | null,
): Resolution {
  const reference = context.userLatLon ?? null;
  if (candidates.length === 1) {
    const via: ResolutionReason = qualified
      ? 'qualifier-pinned'
      : matchTier === 'curated'
        ? 'curated-alias'
        : 'exact-unique';
    return answer(candidates[0], via, index, reference);
  }

  if (context.userLatLon) {
    const winner = dominantNearest(candidates, context.userLatLon, options, options.userLocalKm);
    if (winner) return answer(winner, 'user-location', index, reference);
  }

  const centroid = depth === 0 ? tripCentroid(context.tripDestinationNames, index, options) : null;
  if (centroid) {
    const winner = dominantNearest(candidates, centroid, options);
    if (winner) return answer(winner, 'trip-context', index, reference ?? centroid);
  }

  const measureFrom = reference ?? centroid ?? null;
  const countries = new Set(candidates.map((p) => p.country.toUpperCase()));
  if (countries.size > 1) {
    return {
      status: 'ambiguous',
      candidates: groupCandidates(candidates, index, measureFrom, options),
      reason: 'multi-country',
    };
  }

  // A city against the region or country AROUND it is not a contest between
  // two populations, and the pipeline made that explicit: a region's
  // `population` is the SUM of its member cities, not a census figure, so
  // scoring the two against each other would make every region outrank every
  // city inside it. Prefer the point-like place and compare nothing.
  //
  // `New York` the city against New York the state resolves to the city.
  // `Washington` does NOT: DC is not inside Washington state, so those two
  // really are different places sharing a name, and that stays a question.
  const pointLike = candidates.filter((p) => p.kind === 'city' || p.kind === 'metro');
  if (pointLike.length === 1) {
    const inner = pointLike[0];
    const rest = candidates.filter((p) => p !== inner);
    if (rest.every((container) => qualifierContains(container, inner))) {
      return answer(inner, 'prominence', index, measureFrom);
    }
  }

  const ranked = byProminence(candidates, index);
  const top = scoreOf(ranked[0], index);
  const withinMargin = ranked.filter((p) => scoreOf(p, index) >= top - options.nearTieEpsilon);
  if (withinMargin.length === 1) return answer(ranked[0], 'prominence', index, measureFrom);

  return {
    status: 'ambiguous',
    candidates: groupCandidates(ranked, index, measureFrom, options),
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
      // Narrowed per key, so the alias-only junk hanging off one near-miss
      // cannot crowd out the canonical places found under it. Without this,
      // a typo for `venice` still offers Dayton, Ohio.
      for (const { id } of narrowToBestTier(index.exact.get(hit.key) ?? []).matches) {
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
  if (iataAllowed && head === head.toUpperCase()) return answer(iataHit, 'iata-code', index, reference);

  // QUALIFIER BEFORE PROVENANCE. The order of these two narrowings is
  // load-bearing and getting it wrong cost a working input.
  //
  // A curated alias is the top key tier, so narrowing by tier first reduces
  // `washington` to the single curated reading — Washington DC — and a
  // following qualifier then has nothing to match. Measured:
  // `Washington, Utah` went from SGU to UNKNOWN the moment `washington` was
  // curated onto the capital, and `Washington, England` with it.
  //
  // So when the traveller named a qualifier, that is the stronger signal and
  // it is applied to the WHOLE match set; provenance then decides among
  // whatever survives. Same precedent as the admin-suffix path below, where
  // the kind filter runs before the tier narrowing for exactly this reason:
  // an explicit statement about which place is meant outranks how we happen
  // to know the name.
  //
  // Falls back to the unqualified set when the qualifier matches nothing, so
  // a qualifier that is real but wrong still produces the "found it, but not
  // where you said" question rather than an empty answer.
  const allMatches = matchesForKeys(headKeys, index);
  const allPlaces = placesOf(allMatches, index);
  const qualifierPool = qualifiers.length > 0 ? narrow(allPlaces, qualifiers) : allPlaces;
  const pool = qualifierPool.length > 0 ? qualifierPool : allPlaces;
  const poolIds = new Set(pool.map((place) => place.id));
  const { matches: bestMatches, tier: matchTier } = narrowToBestTier(
    allMatches.filter((match) => poolIds.has(match.id)),
  );
  const exactHits = placesOf(bestMatches, index);
  if (exactHits.length === 0) {
    if (iataAllowed) return answer(iataHit, 'iata-code', index, reference);
    const bareAdmin = adminSuffixSplit(head);
    if (bareAdmin) {
      // The KIND filter runs BEFORE the tier narrowing, and the order is the
      // whole fix: `New York` is a curated alias of New York City, so
      // narrowing first keeps only the city and the kind filter then finds
      // nothing. The traveller said "state", which is a stronger signal than
      // any provenance, so it is applied first.
      const named = matchesForKeys(keysForQuery(bareAdmin), index).filter((match) =>
        ADMIN_KINDS.has(index.byId.get(match.id)?.kind as PlaceKind),
      );
      const retry = prune(
        narrow(placesOf(narrowToBestTier(named).matches, index), qualifiers),
        options,
      );
      // `qualified` is true because the traveller qualified it: naming the
      // kind of place is what a comma segment does by other means.
      if (retry.length > 0) return decide(retry, context, index, options, true, depth, 'canonical');
    }

    // A qualifier separated by a SPACE rather than a comma: `Newark NJ`,
    // `Springfield Illinois`, `Washington DC`, `Vancouver Washington`.
    //
    // People leave the comma out, and so do the AI parsers that feed this —
    // `originAirports.ts` hand-keys `washington dc` precisely because the
    // comma-less form arrives often enough to matter. Step 2 splits on commas
    // only, so `Newark NJ` reaches here as one long head and misses.
    //
    // It runs ONLY after `exact` has missed, which is what makes it safe: any
    // real multi-word name — `new jersey`, `salt lake city`, `new york` — is
    // already a key and never gets here, so this cannot take `new jersey`
    // apart into "New" in Jersey. Everything else is the comma pass exactly:
    // the same `splitHead`, so only a country/state/region key may act as a
    // qualifier and a city key still cannot.
    //
    // It also keeps the browser hot set honest. The hot set stores answers
    // under NORMALISED keys, and normalisation turns a comma into a space —
    // so `Newark, NJ` is stored under `newark nj`, and without this the
    // server would answer that same string differently from the browser.
    // That equality is the whole basis for trusting an offline answer.
    const spaced = spacedQualifierSplit(head, index);
    if (spaced) {
      const combined = [...spaced.qualifiers, ...qualifiers];
      const { matches, tier } = narrowToBestTier(matchesForKeys(keysForQuery(spaced.head), index));
      const retry = prune(narrow(placesOf(matches, index), combined), options);
      if (retry.length > 0) return decide(retry, context, index, options, true, depth, tier);
    }

    return suggest(headKeys, qualifiers, index, reference, options);
  }

  const narrowed = narrow(exactHits, qualifiers);
  if (narrowed.length === 0) {
    if (iataAllowed) return answer(iataHit, 'iata-code', index, reference);
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
  return decide(pruned, context, index, options, qualifiers.length > 0, depth, matchTier);
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
