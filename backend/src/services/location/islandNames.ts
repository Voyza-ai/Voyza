/**
 * Island-style destination names: "Grand Turk Island", "Mykonos Island",
 * "Isle of Skye", "Isla Mujeres".
 *
 * Neither the curated table nor the artifact holds a name with "Island"
 * attached, and Duffel's place search returns nothing for some of them, so
 * "Grand Turk Island" got no flights at all while "Grand Turk" answers GDT.
 * This retries the name with the island word stripped — against the curated
 * table and the artifact only, never against Duffel or the cache, whose fuzzy
 * answers are exactly what destinationAirport.ts exists to refuse.
 *
 * Stripping is dangerous, and the guards below are measured, not assumed.
 * Without them (2026-11-23, against the artifact):
 *
 *   Hamilton Island   -> "Hamilton"  -> YHM, Hamilton, Ontario
 *   Vancouver Island  -> "Vancouver" -> YVR, across the strait (curated row)
 *   Stewart Island    -> "Stewart"   -> CCC, Cuba (an alternate name of a town)
 *   Big Island        -> "Big"       -> EDO, Biga, Turkey
 *
 * Even with the first two guards below, a sweep of 100 island names still
 * answered Dauphin Island (Alabama) with YDN, Dauphin, Manitoba, and Antigua
 * Island with GUA, Antigua, Guatemala: the bare name's famous reading is
 * somewhere else, and nothing in the name says so. Only the trip can.
 *
 * A wrong airport is worse than none, so a stripped name is used only when
 *  - the artifact does not read it as AMBIGUOUS (Hamilton, Vancouver, Norfolk
 *    all are: the remainder of an island name is often a famous town
 *    elsewhere), and
 *  - it is a curated row (Grand Turk -> GDT, Mykonos -> JMK), which answers
 *    with or without a trip, or
 *  - the artifact answers it with a place NAMED what was asked (Biga is not
 *    "Big"; a Cuban town is not "Stewart") that is not a country, AND the
 *    trip has another stop within NEAR_TRIP_KM of its airport — the same
 *    test a Duffel suggestion must pass. With no other stop there is nothing
 *    to check the reading against, and it is not used.
 *
 * A name the artifact already knows WITH its island word (Rhode Island, Long
 * Island, Norfolk Island, Canary Islands) never reaches this: getIataCode
 * only tries it when the full name failed.
 */

import { getStaticIata } from '../../data/cityAirports';
import { haversineKm } from './geo';
import { originIndex } from './originAirports';
import { resolve } from './resolve';
import {
  destinationAnchors,
  destinationCodeOf,
  locateCode,
  namedAsAsked,
  type DestinationContext,
} from './destinationAirport';

const STRIPS: RegExp[] = [
  /\s+(?:island|islands|isle)$/i, // Grand Turk Island, Mykonos Island
  /^(?:isle|island)\s+of\s+/i, // Isle of Skye, Island of Hawaii
  /^isla\s+(?:de\s+)?/i, // Isla Mujeres, Isla de Margarita
];

/** The name with its island word removed, each way that applies; [] when none does. */
export function islandNameVariants(name: string): string[] {
  const trimmed = (name ?? '').trim().replace(/\s+/g, ' ');
  const out: string[] = [];
  for (const re of STRIPS) {
    const stripped = trimmed.replace(re, '').trim();
    if (stripped !== trimmed && stripped.length >= 3 && !out.includes(stripped)) out.push(stripped);
  }
  return out;
}

/**
 * The airport for an island-style name, from its stripped form, or null.
 * See the header for why each guard exists.
 */
export function islandIata(name: string, context: DestinationContext = {}): string | null {
  const variants = islandNameVariants(name);
  if (variants.length === 0) return null;
  const tripAnchors = destinationAnchors(name, context).filter((a) => a.source === 'trip');

  for (const variant of variants) {
    const reading = resolve(variant, {}, originIndex());
    if (reading.status === 'ambiguous') continue;

    let code: string | null = getStaticIata(variant) ?? null;
    if (!code && reading.status === 'resolved' && tripAnchors.length > 0) {
      const place = reading.place;
      if (place.kind === 'country') continue;
      const named = namedAsAsked(variant, {
        iataCode: '',
        country: place.country,
        lat: place.lat,
        lon: place.lon,
        names: [place.name],
      });
      if (!named) continue;
      code = destinationCodeOf(place);
    }
    if (!code) continue;

    if (tripAnchors.length > 0) {
      const at = locateCode(code);
      if (!at) continue; // can't place it, so can't check it against the trip
      if (!tripAnchors.some((a) => haversineKm(a, at) <= a.withinKm)) continue;
    }
    return code;
  }
  return null;
}
