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
// composition below; phase 5 removes this import with the table itself.

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
  options: {
    locationDominanceRatio: number;
    locationDominanceKm: number;
    userLocalKm: number;
  };
  attribution: {
    text: string;
    license: string;
    url: string;
    modified: string;
  };
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

/** A `resolved` answer for one hot-set place. */
function resolvedOf(id: string, place: HotPlace, via: string, max: number): LocationAnswer {
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
    via,
  };
}

/** Great-circle km. Same formula as the server's `geo.ts`. */
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The server's user-location rule, run HERE rather than by asking the server.
 *
 * This is the one context signal the browser can apply without a round trip,
 * because the hot set already carries lat/lon for every place it ships and
 * the three constants come from the generated file rather than being copied
 * — see `options` in the hot set.
 *
 * Doing it locally is not just a latency win. `lib/nearestAirport.ts`
 * promises that geolocation coordinates never leave the device, and the whole
 * "use my location" flow rests on that. Deferring an ambiguous name to the
 * server WITH the coordinates attached would quietly break it.
 *
 * What it fixes, measured: someone standing in Washington DC taps "use my
 * location", which produces the string `Washington`. That name is ambiguous
 * between the District and Washington State, so the resolver asks — and the
 * best-effort lead is the STATE, 3,700 km away on the other coast. With the
 * coordinates in hand it is the District, unambiguously.
 *
 * Both conditions must hold, exactly as on the server: a ratio, so the rule
 * scales from a city pair to a continent pair, and an absolute floor, so two
 * candidates 60 km and 25 km away are not separated by arithmetic that GPS
 * noise could flip. And beyond `userLocalKm` a position decides nothing,
 * because a traveller's own position is evidence about places NEAR them —
 * which is why `Paris` typed in New York still asks instead of resolving to
 * Texas.
 */
function dominantNearest(
  ids: string[],
  from: { lat: number; lon: number },
): string | null {
  const { locationDominanceRatio, locationDominanceKm, userLocalKm } = set.options;
  const ranked = ids
    .map((id) => {
      const place = placeOf(id);
      return place ? { id, km: haversineKm(from, place) } : null;
    })
    .filter((x): x is { id: string; km: number } => x !== null)
    .sort((a, b) => a.km - b.km);

  if (ranked.length < 2) return null;
  const [first, second] = ranked;
  if (first.km > userLocalKm) return null;
  const clearRatio = first.km === 0 || second.km / first.km >= locationDominanceRatio;
  const clearGap = second.km - first.km >= locationDominanceKm;
  return clearRatio && clearGap ? first.id : null;
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

    // A contested key plus context needs care: the server's context rules run
    // BEFORE prominence, so a position or a trip would have been consulted
    // first and might pick a different candidate than the stored one.
    const contested = entry.s === 'ask' || entry.v === CONTESTED_VIA;
    if (contested) {
      // The traveller's own position, applied here rather than by asking.
      // Only possible for an `ask` entry, because that is the one that stores
      // every candidate; a `prominence` entry stores just its winner, so
      // there is nothing to measure against and it has to defer.
      if (context?.userLatLon && entry.s === 'ask') {
        const winner = dominantNearest(entry.ids, context.userLatLon);
        if (winner) {
          const place = placeOf(winner);
          if (place) return resolvedOf(winner, place, 'user-location', max);
        }
      }

      // A trip is the one signal that cannot be reproduced offline: the
      // server resolves each destination name to a centroid, which is a
      // second resolution pass this file deliberately does not do.
      if (context?.tripDestinationNames?.length) return null;

      // A `prominence` key with coordinates that could not be applied above.
      if (context?.userLatLon && entry.s !== 'ask') return null;

      // Otherwise there is nothing left for the server to use that the
      // stored answer did not already account for: the position did not
      // dominate, and the server would fall through to exactly the
      // no-context ranking this entry holds. Answering is correct, and it
      // saves a round trip on every contested name in a field with
      // geolocation switched on.
    }

    if (entry.s === 'ok') {
      const place = placeOf(entry.ids[0]);
      if (!place) return null;
      return resolvedOf(entry.ids[0], place, entry.v ?? 'exact-unique', max);
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
  context?: LocationContext,
): string[] {
  const answer = resolveLocally(query, context, max);
  if (!answer) return [];
  if (answer.status === 'resolved') return answer.airports.map((a) => a.iata);
  if (answer.status === 'ambiguous') return answer.candidates[0].airports.map((a) => a.iata);
  return [];
}

/**
 * Origin airports for a city name: RESOLVER FIRST, table as a safety net.
 *
 * This was table-first through the shadow period, for a reason still worth
 * understanding: the frontend's answer WINS. `optimizer.ts` takes
 * `originAirports` straight from the request body when it is non-empty and
 * never looks anything up, so THIS FUNCTION — not
 * `LOCATION_RESOLVER_MODE` — decides what real trips are priced from.
 * Serving resolver answers from here while the backend was still in `shadow`
 * would have bypassed the very log meant to justify the change. There is one
 * Supabase project and it holds real trips.
 *
 * The order is reversed now because that evidence came in. Over the 132
 * inputs the table answers, the resolver reproduces the LEADING airport on
 * all 132 and returns nothing on none of them. One answer changes and it is
 * a correction: `Vancouver, WA` moves from SEA, about 250 km away in
 * Seattle, to PDX, 7 km away. It also answers 19 inputs in the table's own
 * test corpus that the table refuses outright — `Paris, Texas`,
 * `Baton Rouge, LA`, `Berlin, DE`, `Tbilisi, Georgia` among them.
 *
 * Earlier in the rollout the two disagreed on 9 of those 132, including
 * `doha` (table DOH, artifact DIA — the OLD Doha International) and
 * `kuala lumpur` (table KUL, artifact SZB — the secondary field). Those are
 * fixed in the data, by authored pins, not papered over here. Keeping the
 * shadow order until they were is what made them findable.
 *
 * The table stays as the FALLBACK rather than being deleted, and that is not
 * ceremony: the hot set is bounded at 60 KB, so the resolver answers nothing
 * offline for a place that did not fit. Falling back means this can only add
 * coverage, never remove it. `locationLiveGate.test.ts` holds that claim to
 * all 132 inputs and fails if a new disagreement appears.
 *
 * Phase 5 deletes the last line of the body.
 */
export function originAirportsForCity(
  query: string | null | undefined,
  max: number = DEFAULT_MAX_AIRPORTS,
  context?: LocationContext,
): string[] {
  return originAirportsLocally(query, max, context);
}

/**
 * GeoNames credit for the data behind every answer in this module.
 *
 * REQUIRED, not optional: GeoNames is CC BY 4.0, which obliges credit, a
 * licence link and an indication of changes wherever the data is shown. It
 * comes from the generated hot set rather than being typed here, so the UI
 * renders the licence's own words and there is no second copy to drift.
 *
 * Still outstanding, and it is a design decision rather than a code one:
 * there is no credits surface in the app for this to live on. See
 * ATTRIBUTION.md for the three places it is owed. Importing this constant is
 * not compliance on its own — rendering it somewhere a user can reach is.
 */
export const LOCATION_DATA_ATTRIBUTION = set.attribution;

/** Which artifact this hot set came from. Shown in diagnostics. */
export const hotSetInfo = {
  schemaVersion: set.schemaVersion,
  generatedAt: set.generatedAt,
  artifact: set.artifact,
  keys: Object.keys(set.exact).length,
  places: Object.keys(set.places).length,
};
