/**
 * Location resolution in the browser: hot set first, server for the long tail.
 *
 * This replaces `lib/originAirports.ts`, a hand-maintained 68-key table that
 * had a hand-maintained twin in the backend. There is no twin any more — the
 * data here is generated from the same artifact the server resolves against,
 * and `lib/locationKeys.ts` is a byte-for-byte copy of the server's
 * normaliser, guarded by a parity test in both packages.
 *
 * ── What is answered here, and what is asked ────────────────────────────────
 *
 * The hot set stores ANSWERS, not places, and only for keys whose whole
 * candidate set shipped with them. So a key present here resolves exactly as
 * the server would; it is never a confident guess made from a subset. Anything
 * absent is a miss, not a wrong answer.
 *
 * Context is the one thing that can make a stored answer stale, and only for
 * the keys where the resolver had rivals to choose between. Those carry
 * `v: 'prominence'`; measured on the current artifact there are 53 of them
 * against 4,668 that cannot be changed by context at all. So:
 *
 *   - no key                        -> ask the server
 *   - key, and no rivals            -> answer offline, always
 *   - key with rivals, no context   -> answer offline (same answer the
 *                                      server would give with no context)
 *   - key with rivals, and context  -> ask the server, which can use it
 *
 * The point of a hot set is a field that answers while someone types. A
 * typeahead that round-trips on every keystroke is slower than the table this
 * replaces, which would make the whole exercise a regression.
 */

import hotSet from './generated/locationHotSet.json';
import { keysForQuery } from './locationKeys';
// The table this replaces. Used only by `originAirportsForCity`, the rollout
// composition below; phase 5 removes this import with the table itself.
import { getOriginAirports as legacyOriginAirports } from './originAirports';

export type LocationKind = 'city' | 'metro' | 'region' | 'state' | 'country';

export type LocationAirport = {
  iata: string;
  km: number;
  servesPlace: boolean;
};

export type LocationPlace = {
  placeId: string;
  name: string;
  country: string;
  admin: string | null;
  kind: LocationKind;
  lat: number;
  lon: number;
};

export type LocationCandidate = {
  placeId: string;
  name: string;
  /** "Paris, Île-de-France, France" — enough to tell two readings apart. */
  label: string;
  country: string;
  admin: string | null;
  kind: LocationKind;
  airports: LocationAirport[];
  distanceKm?: number;
  editDistance?: number;
};

/**
 * The same three results the server gives, so a caller handles one shape
 * whichever side answered.
 *
 * A silent empty and a confident wrong are both bugs. The resolver is allowed
 * not to know; it is not allowed to pretend.
 */
export type LocationAnswer =
  | { status: 'resolved'; place: LocationPlace; airports: LocationAirport[]; via: string }
  | {
      status: 'ambiguous';
      reason: 'multi-country' | 'near-tie';
      candidates: LocationCandidate[];
    }
  | { status: 'unknown'; suggestions: LocationCandidate[] };

export type LocationContext = {
  userLatLon?: { lat: number; lon: number };
  userCountry?: string;
  tripDestinationNames?: string[];
};

type HotPlace = {
  n: string;
  c: string;
  a: string | null;
  t: LocationKind;
  ap: Array<[string, number, 0 | 1]>;
  lat: number;
  lon: number;
};

type HotEntry = { s: 'ok' | 'ask'; ids: string[]; v?: string };

type HotSet = {
  schemaVersion: number;
  generatedAt: string;
  artifact: { schemaVersion: number; generatedAt: string };
  places: Record<string, HotPlace>;
  exact: Record<string, HotEntry>;
  iata: Record<string, string>;
  /** Display names for the codes the shipped places carry. */
  countryNames: Record<string, string>;
  adminNames: Record<string, string>;
};

const set = hotSet as unknown as HotSet;

/** The default the hand-written table always applied. */
export const DEFAULT_MAX_AIRPORTS = 3;

/**
 * The only `via` that means the resolver had rivals, so the only one where
 * context could have produced a different answer. Everything else is reached
 * with exactly one candidate in hand.
 */
const CONTESTED_VIA = 'prominence';

function airportsOf(place: HotPlace, max: number): LocationAirport[] {
  return place.ap.slice(0, max).map(([iata, km, serves]) => ({
    iata,
    km,
    servesPlace: serves === 1,
  }));
}

function placeOf(id: string): HotPlace | null {
  return set.places[id] ?? null;
}

/**
 * "Paris, Île-de-France, France" — the same label the server builds.
 *
 * The hot set ships display names for the codes its own places carry, so this
 * reads "Île-de-France" rather than the raw admin code `11`. That matters
 * because this text IS the question put to the traveller: "Paris, 11, FR" is
 * a worse question than "Paris, Île-de-France, France", and the two readings
 * of `Washington` are indistinguishable without it.
 *
 * Falls back to the code when a name is missing, so a place that shipped
 * without one still labels as something rather than nothing.
 *
 * A part that repeats the name is dropped, so the state of Georgia reads
 * "Georgia, United States" and not "Georgia, Georgia, United States".
 */
function labelOf(place: HotPlace): string {
  const country = place.c.toUpperCase();
  const parts = [place.n];
  const push = (part: string | null | undefined): void => {
    if (part && !parts.includes(part)) parts.push(part);
  };
  if (place.a) push(set.adminNames[`${country}:${place.a.toUpperCase()}`] ?? place.a);
  push(set.countryNames[country] ?? place.c);
  return parts.join(', ');
}

function candidateOf(id: string, max: number): LocationCandidate | null {
  const place = placeOf(id);
  if (!place) return null;
  return {
    placeId: id,
    name: place.n,
    label: labelOf(place),
    country: place.c,
    admin: place.a,
    kind: place.t,
    airports: airportsOf(place, max),
  };
}

function hasContext(context: LocationContext | undefined): boolean {
  if (!context) return false;
  return Boolean(context.userLatLon ?? context.tripDestinationNames?.length);
}

/** An all-caps three-letter head is a code, not a town: `ORD` is O'Hare. */
function iataAnswer(query: string, max: number): LocationAnswer | null {
  const head = query.trim();
  if (head.length !== 3 || head !== head.toUpperCase()) return null;
  const id = set.iata[head];
  if (!id) return null;
  const place = placeOf(id);
  if (!place) return null;
  return {
    status: 'resolved',
    place: {
      placeId: id,
      name: place.n,
      country: place.c,
      admin: place.a,
      kind: place.t,
      lat: place.lat,
      lon: place.lon,
    },
    airports: airportsOf(place, max),
    via: 'iata-code',
  };
}

/**
 * Resolve from the hot set alone. `null` means "the browser cannot answer
 * this" — a miss, or a key whose answer the given context could change.
 *
 * Synchronous on purpose: this is what makes a typeahead usable, and what
 * lets `HomeEditModal` keep working without becoming async.
 */
export function resolveLocally(
  query: string | null | undefined,
  context?: LocationContext,
  max: number = DEFAULT_MAX_AIRPORTS,
): LocationAnswer | null {
  const raw = (query ?? '').trim();
  if (!raw) return null;

  const direct = iataAnswer(raw, max);
  if (direct) return direct;

  for (const key of keysForQuery(raw)) {
    const entry = set.exact[key];
    if (!entry) continue;

    // Rivals plus context is the server's call: the context rules run before
    // prominence, so a position or a trip would have been consulted first and
    // might pick a different candidate than the stored one.
    if (entry.v === CONTESTED_VIA && hasContext(context)) return null;
    if (entry.s === 'ask' && hasContext(context)) return null;

    if (entry.s === 'ok') {
      const place = placeOf(entry.ids[0]);
      if (!place) return null;
      return {
        status: 'resolved',
        place: {
          placeId: entry.ids[0],
          name: place.n,
          country: place.c,
          admin: place.a,
          kind: place.t,
          lat: place.lat,
          lon: place.lon,
        },
        airports: airportsOf(place, max),
        via: entry.v ?? 'exact-unique',
      };
    }

    const candidates = entry.ids
      .map((id) => candidateOf(id, max))
      .filter((c): c is LocationCandidate => c !== null);
    if (candidates.length < 2) return null;
    return {
      status: 'ambiguous',
      // The hot set does not store which of the two reasons it was, and the
      // distinction only changes the wording of the question. Candidates
      // spanning more than one country is the common case and is checked
      // first by the resolver, so it is derivable rather than guessed.
      reason: new Set(candidates.map((c) => c.country)).size > 1 ? 'multi-country' : 'near-tie',
      candidates,
    };
  }

  return null;
}

/**
 * Always answers: the hot set when it can, the server otherwise.
 *
 * Never throws and never returns nothing. A failed request degrades to
 * `unknown` with no suggestions, which the caller turns into a question —
 * the same outcome as a genuine miss, and better than an exception in a
 * keystroke handler.
 */
export async function resolveLocation(
  query: string | null | undefined,
  context?: LocationContext,
  max: number = DEFAULT_MAX_AIRPORTS,
): Promise<LocationAnswer> {
  const raw = (query ?? '').trim();
  if (!raw) return { status: 'unknown', suggestions: [] };

  const local = resolveLocally(raw, context, max);
  if (local) return local;

  try {
    const response = await fetch(`${apiBase()}/api/locations/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: raw, ...(context ?? {}), max }),
    });
    if (!response.ok) return { status: 'unknown', suggestions: [] };
    return (await response.json()) as LocationAnswer;
  } catch {
    return { status: 'unknown', suggestions: [] };
  }
}

/** Same default as `lib/api.ts`, so a dev with no env still reaches the API. */
function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
}

/**
 * Drop-in for `getOriginAirports(city)`: IATA codes, best-first, possibly
 * empty — synchronous, from the hot set.
 *
 * Returns the best reading's airports for an ambiguous name, because that is
 * what the table it replaces did with no way to say otherwise. A caller that
 * can ask a question should use `resolveLocally` and read the candidates
 * instead; this exists so the migration is one line per call site.
 */
export function originAirportsLocally(
  query: string | null | undefined,
  max: number = DEFAULT_MAX_AIRPORTS,
): string[] {
  const answer = resolveLocally(query, undefined, max);
  if (!answer) return [];
  if (answer.status === 'resolved') return answer.airports.map((a) => a.iata);
  if (answer.status === 'ambiguous') return answer.candidates[0].airports.map((a) => a.iata);
  return [];
}

/**
 * The ROLLOUT composition: the hand-written table first, the hot set second.
 *
 * This is what the synchronous call sites use, and it is deliberately not a
 * switch to the resolver. The reason is that the frontend's answer WINS:
 * `optimizer.ts` takes `originAirports` straight from the request body when it
 * is non-empty and never looks anything up. So calling `originAirportsLocally`
 * directly from a call site serves resolver answers to every trip no matter
 * what `LOCATION_RESOLVER_MODE` says, which bypasses the shadow log that is
 * supposed to justify the change. There is one Supabase project and it holds
 * real trips.
 *
 * Measured, that bypass is not theoretical. Across the table's own 132 keys
 * the two disagree on the leading airport for 9 of them, and before the
 * curated pins were seeded those included `doha` (table DOH, artifact DIA —
 * the OLD Doha International) and `kuala lumpur` (table KUL, artifact SZB —
 * the secondary field). Shipping those silently is the kind of regression
 * shadow mode exists to catch.
 *
 * So this is additive by construction: every input the table answers keeps the
 * table's answer, byte for byte. The only behaviour that changes is inputs the
 * table answered with NOTHING — `Paris, Texas`, `Baton Rouge, LA`,
 * `Berlin, DE`, `Tbilisi, Georgia`, 18 of them in the table's own corpus —
 * which previously fell through to a single-airport guess or a logged warning.
 *
 * Phase 5 deletes the first line of the body. Until the flip is justified, it
 * can only add coverage.
 */
export function originAirportsForCity(
  query: string | null | undefined,
  max: number = DEFAULT_MAX_AIRPORTS,
): string[] {
  const fromTable = query ? legacyOriginAirports(query, max) : [];
  if (fromTable.length > 0) return fromTable;
  return originAirportsLocally(query, max);
}

/** Which artifact this hot set came from. Shown in diagnostics. */
export const hotSetInfo = {
  schemaVersion: set.schemaVersion,
  generatedAt: set.generatedAt,
  artifact: set.artifact,
  keys: Object.keys(set.exact).length,
  places: Object.keys(set.places).length,
};
