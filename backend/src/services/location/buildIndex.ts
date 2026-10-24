/**
 * Build the four lookup indexes from an artifact. Called once per process.
 *
 * The one rule in here that earns its keep: **a city key never enters
 * `qualifier`**. `LA` is an alias of Los Angeles the city, and a city reading
 * must not be able to consume a comma segment, narrow the head or veto it —
 * which is what stops `Paris, Texas` → CDG, `Berlin, DE` → Delaware and
 * `Baton Rouge, LA` → Los Angeles.
 *
 * It is enforced twice, here and in `qualifierContains`, and mutation testing
 * showed that is not redundant decoration: breaking either one alone leaves
 * the must-never set passing, so a future reader who deletes "the duplicate"
 * will find the tests still green. Both are asserted directly.
 *
 * `qualifier` is multi-valued because it must hold both Georgia-the-state and
 * Georgia-the-country, and `DE` for both Delaware and Germany. A single-valued
 * map is a wrong-continent bug waiting for a rebuild to reorder the input.
 */

import type {
  IataCode,
  KeyMatch,
  KeyTier,
  LocationArtifact,
  LocationIndex,
  Place,
  PlaceKind,
} from './types';
import { normalizeKeys, tieredKeysFor } from './normalize';
import { buildTrigramIndex } from './trigram';
import { prominenceOf } from './prominence';

/** Kinds whose keys may act as a qualifier after a comma. Cities may not. */
const QUALIFIER_KINDS: ReadonlySet<PlaceKind> = new Set<PlaceKind>([
  'country',
  'region',
  'state',
]);

export type BuiltIndex = LocationIndex & {
  /** Display name per ISO country code, for candidate labels. */
  countryNames: Map<string, string>;
  /** Display name per `${country}:${admin}`, for candidate labels. */
  adminNames: Map<string, string>;
  /** Cached prominence, so ranking never re-derives it per query. */
  prominence: Map<string, number>;
};

type IataClaim = { id: string; strength: number };

/**
 * `iata` is single-valued, so a shared code needs a rule for who owns it.
 *
 * The first version of this file let the most prominent claimant win, which
 * resolved `LAX` to the United States — the country place legitimately lists
 * LAX among its airports and outweighs every city on earth. A traveller typing
 * a three-letter code means an airport, so:
 *
 *  - only a point-like place may own a code; a country or state takes one only
 *    if no city or metro claimed it at all (so an airport whose city is
 *    missing from the artifact still resolves to something real)
 *  - the place whose FIRST airport it is wins, which is the primary-airport
 *    relationship: `BUR` is Burbank even though Los Angeles also lists it
 *  - `servesPlace` breaks the next tie, then prominence, via iteration order
 *
 * The result: LAX → Los Angeles, BUR → Burbank, EWR → Newark, JFK → New York.
 */
function claimIataCodes(place: Place, claims: Map<string, IataClaim>): void {
  const pointLike = place.kind === 'city' || place.kind === 'metro';
  const offer = (code: string | null | undefined, strength: number): void => {
    const upper = code?.toUpperCase();
    if (!upper) return;
    const held = claims.get(upper);
    // Strictly greater, so the prominence-ordered iteration breaks ties.
    if (!held || strength > held.strength) claims.set(upper, { id: place.id, strength });
  };

  place.airports.forEach((airport, position) => {
    const strength =
      (pointLike ? 8 : 0) + (position === 0 ? 4 : 0) + (airport.servesPlace ? 2 : 0);
    offer(airport.iata, strength);
  });
  // A metro code belongs to the place it names, so it outranks any airport
  // claim on the same letters.
  offer(place.metro, pointLike ? 15 : 1);
}

function pushUnique(map: Map<string, string[]>, key: string, id: string): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [id]);
    return;
  }
  if (!existing.includes(id)) existing.push(id);
}

/** Comparable form of `KeyTier`. Higher is more trusted. */
const KEY_TIER_RANK: Record<KeyTier, number> = {
  curated: 3,
  canonical: 2,
  alias: 1,
};

export function keyTierRank(tier: KeyTier): number {
  return KEY_TIER_RANK[tier];
}

/**
 * Add a (key, place) match, keeping the BEST provenance when the same place
 * reaches the same key twice — a string that is both the curated alias and a
 * dataset alternate name is a curated match.
 */
function pushMatch(map: Map<string, KeyMatch[]>, key: string, id: string, tier: KeyTier): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [{ id, tier }]);
    return;
  }
  const held = existing.find((m) => m.id === id);
  if (!held) {
    existing.push({ id, tier });
    return;
  }
  if (KEY_TIER_RANK[tier] > KEY_TIER_RANK[held.tier]) held.tier = tier;
}

export function buildIndex(artifact: LocationArtifact): BuiltIndex {
  const exact = new Map<string, KeyMatch[]>();
  const qualifier = new Map<string, string[]>();
  const iata = new Map<IataCode, string>();
  const byId = new Map<string, Place>();
  const countryNames = new Map<string, string>();
  const adminNames = new Map<string, string>();
  const prominence = new Map<string, number>();
  const iataClaims = new Map<string, IataClaim>();

  // Most prominent first, so the single-valued `iata` map resolves a shared
  // code to the place a traveller means: LAX is Los Angeles, not Burbank, even
  // though both legitimately list it.
  const places = [...artifact.places].sort(
    (a, b) => prominenceOf(b) - prominenceOf(a) || a.id.localeCompare(b.id),
  );

  for (const place of places) {
    byId.set(place.id, place);
    prominence.set(place.id, prominenceOf(place));

    if (place.kind === 'country') countryNames.set(place.country.toUpperCase(), place.name);
    if ((place.kind === 'state' || place.kind === 'region') && place.admin) {
      adminNames.set(`${place.country.toUpperCase()}:${place.admin.toUpperCase()}`, place.name);
    }

    const keys = tieredKeysFor(place);
    // Codes come from the TYPED fields, not from `aliases`.
    //
    // `Berlin, DE` has to work, and the only way to know that `DE` means
    // Germany without trusting the pipeline to have written "DE" into an alias
    // list is to read `country` on a country place and `admin` on a state. The
    // contract guarantees those fields; it says nothing about aliases
    // containing codes. A numeric admin code (GeoNames emits some) normalises
    // to no key at all and is dropped, which is the correct outcome.
    //
    // An official code is CANONICAL: `LA` means Louisiana as surely as
    // "Louisiana" does. It still loses to a curated alias, which is what makes
    // `la` resolve to Los Angeles rather than offering the traveller Laos.
    const codeTexts: string[] = [];
    if (place.kind === 'country') codeTexts.push(place.country);
    if (place.kind === 'state' || place.kind === 'region') {
      if (place.admin) codeTexts.push(place.admin);
    }
    for (const text of codeTexts) {
      for (const key of normalizeKeys(text)) keys.push({ key, tier: 'canonical' });
    }

    for (const { key, tier } of keys) {
      pushMatch(exact, key, place.id, tier);
      if (QUALIFIER_KINDS.has(place.kind)) pushUnique(qualifier, key, place.id);
    }

    claimIataCodes(place, iataClaims);
  }

  for (const [code, claim] of iataClaims) iata.set(code, claim.id);

  return {
    exact,
    qualifier,
    iata,
    byId,
    fuzzy: buildTrigramIndex(exact.keys()),
    countryNames,
    adminNames,
    prominence,
  };
}
