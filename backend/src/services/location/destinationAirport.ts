/**
 * The resolver, in the shape the DESTINATION side needs: one code per name.
 *
 * `getIataCode` turns a destination city into the single IATA code Duffel
 * searches. It used to go curated table -> `airport_codes` cache -> Duffel's
 * `suggestions[0]`, and never asked the 36,009-place artifact at all. Duffel's
 * place search is fuzzy, and whatever it returned was cached forever. Measured
 * in production: Siena -> JHB (Senai, Malaysia), Sintra -> SQG (Sintang,
 * Indonesia), Bath -> BUT (Bathpalathang, Bhutan), Monteverde -> MVD
 * (Montevideo, Uruguay). The artifact answers the first three correctly, from
 * data, with distances: FLR 56 km, LIS 21 km, BRS 25 km.
 *
 * So this module answers from the artifact first, and when it cannot, says
 * what the artifact KNOWS about where the name is, so a Duffel suggestion can
 * be checked against it before it is trusted or cached.
 *
 * The contract is `metro ?? airports[0]` — the one docs/LOCATION_RESOLUTION.md
 * settled for destinations and `cityAirportsDecisions.test.ts` measures the
 * curated table against: a metro code searches every airport of a city in one
 * call, which is what a destination wants.
 */

import type { Place, Resolution, ResolveContext } from './types';
import { resolve } from './resolve';
import { fromResolution, originIndex } from './originAirports';
import { haversineKm } from './geo';
import { keysForQuery } from './normalize';
import { DEFAULT_OPTIONS } from './options';

/**
 * What a destination caller may know. Names only, like the resolver's own
 * field: the optimizer holds plain city strings.
 */
export type DestinationContext = Pick<ResolveContext, 'tripDestinationNames'>;

/**
 * How near another stop on the trip a reading must be for the trip to count
 * as evidence for it, and how near a Duffel suggestion must be to the trip to
 * be believed.
 *
 * The resolver's trip-context rule measures DOMINANCE from the trip centroid
 * with no distance cap, which is the right call for the question it was built
 * for ("which Rome is home") and the wrong one for a price. Measured: with
 * New York as the only other stop, `Paris` resolves by trip context to Paris,
 * Texas — 2,100 km away against France's 5,800, which clears the ratio — and
 * a destination answer would then fly the traveller to Dallas. So for a
 * destination the chosen reading must also sit within this distance of a
 * real stop. 1,000 km is the resolver's own radius for a traveller's position
 * being evidence about a place (`userLocalKm`); Lagos, Portugal is 190 km from
 * Lisbon, Naples, Florida 170 km from Miami, Guadalajara, Spain 55 km from
 * Madrid.
 */
export const NEAR_TRIP_KM = DEFAULT_OPTIONS.userLocalKm;

/**
 * How near the named place itself a Duffel suggestion must be. The resolver's
 * prune range: "about a 2-hour drive, which the owner accepted as a real
 * option provided the distance is shown".
 */
export const NEAR_PLACE_KM = DEFAULT_OPTIONS.maxAirportKm;

/** `metro ?? airports[0]`, or null for a place with no scheduled airport. */
export function destinationCodeOf(place: Place): string | null {
  return place.metro ?? place.airports[0]?.iata ?? null;
}

function sameName(a: string, b: string): boolean {
  const left = keysForQuery(a);
  return keysForQuery(b).some((key) => left.includes(key));
}

/**
 * The reading a caller with no way to ask lands on: the resolved place, or
 * the lead of an ambiguous answer after the origin side's point-over-area
 * preference — `fromResolution`, reused rather than restated, so the two sides
 * cannot pick different leads for one name. Null for `unknown`.
 */
function bestReading(name: string): Place | null {
  return leadOf(resolve(name, {}, originIndex()));
}

function leadOf(result: Resolution): Place | null {
  if (result.status === 'unknown') return null;
  const { placeId } = fromResolution(result);
  return placeId ? originIndex().byId.get(placeId) ?? null : null;
}

/**
 * Is this the name of a COUNTRY? Then no single airport is its answer.
 *
 * Measured over all 234 country names in the artifact: the destination
 * contract (`metro ?? airports[0]`) answers 15 of them in ANOTHER country,
 * because a country carries no population and so loses on prominence to a
 * town that shares its name — Jamaica -> HAV (Jamaica, Cuba), Jordan -> HKG,
 * Lebanon -> BNA (Lebanon, Tennessee), Costa Rica -> CUL (Costa Rica,
 * Sinaloa). And where the country does win, its first airport is ranked from
 * its centroid, so Italy answered PEG, Perugia, and Japan NGO. Declining is
 * the honest answer: the caller falls through to a suggestion that must
 * survive the checks below, and otherwise to "no IATA code", which the
 * optimizer already handles.
 */
function namesACountry(result: Resolution): boolean {
  if (result.status === 'resolved') return result.place.kind === 'country';
  if (result.status === 'ambiguous') {
    return result.candidates.some((candidate) => candidate.place.kind === 'country');
  }
  return false;
}

/**
 * The OTHER stops on the trip, as places. The name itself is dropped: the
 * resolver averages every trip name into its centroid, so a trip that lists
 * `Lagos` among its own stops would pull the centroid toward Nigeria while
 * deciding which Lagos it is.
 */
function otherStops(name: string, context: DestinationContext): { names: string[]; places: Place[] } {
  const names = (context.tripDestinationNames ?? []).filter((other) => !sameName(other, name));
  const places: Place[] = [];
  for (const other of names) {
    const place = bestReading(other);
    if (place) places.push(place);
  }
  return { names, places };
}

/**
 * The reading the trip picks, when it picks one this module should believe.
 *
 * Only `trip-context` counts: any other `via` means context changed nothing,
 * and the no-context reading stands. And the reading must be near a real
 * stop — see `NEAR_TRIP_KM` for the Paris, Texas case that rule exists for.
 */
export function readingForTrip(name: string, context: DestinationContext = {}): Place | null {
  const { names, places } = otherStops(name, context);
  if (names.length === 0) return null;
  const result = resolve(name, { tripDestinationNames: names }, originIndex());
  if (result.status !== 'resolved' || result.via !== 'trip-context') return null;
  const near = places.some((stop) => haversineKm(stop, result.place) <= NEAR_TRIP_KM);
  return near ? result.place : null;
}

/**
 * The destination code the artifact gives for a name, or null.
 *
 * The trip's reading when it has one, otherwise the best reading with no
 * context — so a bare `Portland` answers PDX, as it would have with no trip,
 * and `Portland` on a trip through Boston answers PWM.
 *
 * Context reaches ONLY names the curated table does not hold. A curated row
 * is a decision about the famous reading of a name, and trip context is not
 * strong enough evidence to overturn one. Measured on the 40 curated names
 * that have another reading, the trip rule flips `Vancouver` on a Seattle and
 * Portland trip to Vancouver, Washington (PDX), `Rome` with Atlanta to Rome,
 * Georgia (ATL), and `London` with Toronto to London, Ontario (YXU) — each a
 * plausible misreading that would price the wrong country.
 */
export function resolveDestinationIata(name: string, context: DestinationContext = {}): string | null {
  if (!name || !name.trim()) return null;
  const onTrip = readingForTrip(name, context);
  if (onTrip) return onTrip.kind === 'country' ? null : destinationCodeOf(onTrip);
  const bare = resolve(name, {}, originIndex());
  if (namesACountry(bare)) return null;
  const place = leadOf(bare);
  return place ? destinationCodeOf(place) : null;
}

// ─── What the artifact knows when it cannot answer ──────────────────────────

/** A point a Duffel suggestion must sit near to be believed. */
export type DestinationAnchor = {
  lat: number;
  lon: number;
  country: string;
  /** Km a suggestion may sit from this point. */
  withinKm: number;
  /** Whether the suggestion must also be in `country`. */
  sameCountry: boolean;
  /** For logs: which kind of evidence this is. */
  source: 'place' | 'trip';
};

/**
 * Where the artifact says this name is, for a name it could not answer.
 *
 * Two kinds of evidence, and nothing else:
 *
 *  - THE PLACE ITSELF. The artifact keeps places with no scheduled airport in
 *    range, and the resolver returns one of those as `unknown` with itself as
 *    the suggestion. Its position and country are known exactly, so a
 *    suggestion must be in that country and within a 2-hour drive.
 *  - THE TRIP. The other stops. A suggestion must be near one of them.
 *    Country is not required here, and that is measured rather than lax:
 *    across the preset catalogue, 22 of 51 cities have their nearest trip-mate
 *    in ANOTHER country, so "same country as the trip" would refuse an honest
 *    answer for any border town. Distance alone still refuses every wrong
 *    answer production cached — each is 5,000 km or more from its trip.
 *
 * A fuzzy near-miss is never evidence: `Hakone` is one edit from Hikone, 230
 * km away, and that is exactly the kind of guess this exists to refuse.
 */
export function destinationAnchors(
  name: string,
  context: DestinationContext = {},
): DestinationAnchor[] {
  const anchors: DestinationAnchor[] = [];
  if (!name || !name.trim()) return anchors;

  const own = resolve(name, {}, originIndex());
  if (own.status === 'unknown') {
    for (const suggestion of own.suggestions) {
      // An exact match carries no edit distance. A fuzzy one always does.
      if (suggestion.editDistance !== undefined) continue;
      const { lat, lon, country } = suggestion.place;
      anchors.push({ lat, lon, country, withinKm: NEAR_PLACE_KM, sameCountry: true, source: 'place' });
    }
  }

  for (const stop of otherStops(name, context).places) {
    anchors.push({
      lat: stop.lat,
      lon: stop.lon,
      country: stop.country,
      withinKm: NEAR_TRIP_KM,
      sameCountry: false,
      source: 'trip',
    });
  }
  return anchors;
}

/**
 * A code from outside the artifact — a Duffel suggestion, or an
 * `airport_codes` row — reduced to the fields a check needs.
 */
export type SuggestedPlace = {
  iataCode: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
  /** Duffel's own names for it: the airport or city name, and `city_name`. */
  names: string[];
};

/**
 * Where the artifact puts a code: the place that owns it in the IATA index
 * (the city whose primary airport it is, or the city a metro code names).
 *
 * An `airport_codes` row has no coordinates, and a Duffel `city` place may
 * have none either, so this is how they get checked at all. It is the
 * owner's position, not the runway's — within the 150 km attach radius by
 * construction, and for a primary airport usually a few km — which is
 * precise enough to tell Malaysia from Tuscany.
 */
export function locateCode(iata: string): { lat: number; lon: number; country: string } | null {
  const index = originIndex();
  const id = index.iata.get(iata.toUpperCase());
  const place = id ? index.byId.get(id) : undefined;
  return place ? { lat: place.lat, lon: place.lon, country: place.country } : null;
}

/** Fill a suggestion's missing position and country from the artifact. */
export function locatedFromArtifact(place: SuggestedPlace): SuggestedPlace {
  if (place.lat !== null && place.lon !== null && place.country) return place;
  const found = locateCode(place.iataCode);
  if (!found) return place;
  return {
    ...place,
    country: place.country ?? found.country,
    lat: place.lat ?? found.lat,
    lon: place.lon ?? found.lon,
  };
}

/**
 * Is this code where the artifact says the name is? False when it cannot be
 * placed at all: with evidence in hand, an unplaceable code is not accepted.
 */
export function consistentWithAnchors(place: SuggestedPlace, anchors: DestinationAnchor[]): boolean {
  const located = locatedFromArtifact(place);
  if (located.lat === null || located.lon === null) return false;
  const point = { lat: located.lat, lon: located.lon };
  return anchors.some((anchor) => {
    if (anchor.sameCountry && (located.country ?? '').toUpperCase() !== anchor.country.toUpperCase()) {
      return false;
    }
    return haversineKm(point, anchor) <= anchor.withinKm;
  });
}

/**
 * Does Duffel's own name for the suggestion contain what was asked, as whole
 * words? The only check left when the artifact knows nothing about the name.
 *
 * Whole words, because the measured failures are all near-misses: "Siena" is
 * not "Senai", "Sintra" is not "Sintang", and "Bath" is not "Bathpalathang" —
 * a prefix match would have accepted Bhutan.
 */
export function namedAsAsked(query: string, place: SuggestedPlace): boolean {
  const asked = keysForQuery(query);
  if (asked.length === 0) return false;
  return place.names.some((name) =>
    keysForQuery(name).some((hay) => asked.some((key) => ` ${hay} `.includes(` ${key} `))),
  );
}
