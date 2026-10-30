import { originIndex } from './originAirports';

/**
 * Do two airport codes name the SAME place to fly from and to?
 *
 * A flight from a place to itself is not a journey. It happens because towns
 * with no airport of their own are priced through their gateway: Interlaken,
 * Lucerne and Zermatt are ZRH, Siena is FLR, Kyoto and Kobe are OSA, Oxford
 * is LON. A Zurich → Interlaken leg then becomes a ZRH → ZRH flight search
 * (integrated run, 2026-10-30: two such requests reached Duffel on one Swiss
 * trip). That leg is ground travel; it has no flight option.
 *
 * Same place means:
 *  - the same code (ZRH and ZRH), or
 *  - a metro code and one of its own airports (LON and LHR, NYC and EWR), or
 *  - two airports of one metro (LHR and LGW, JFK and EWR).
 *
 * A metro's airports are the ones the location artifact files as serving the
 * metro's own city (`servesPlace`). The rest of its list is merely nearby —
 * Osaka's lists Nagoya, Milan's lists Turin — and real flights connect those,
 * so they never count. Codes outside every metro are only ever equal to
 * themselves: GVA and ZRH stay different, as do FLR and PSA.
 */
export function sameAirportArea(a: string, b: string): boolean {
  const x = a.trim().toUpperCase();
  const y = b.trim().toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const metrosOfX = metroMembership().get(x);
  if (!metrosOfX) return false;
  const metrosOfY = metroMembership().get(y);
  if (!metrosOfY) return false;
  for (const metro of metrosOfX) if (metrosOfY.has(metro)) return true;
  return false;
}

/** code -> the metro codes it belongs to (a metro code belongs to itself). */
let membership: Map<string, Set<string>> | null = null;

function metroMembership(): Map<string, Set<string>> {
  if (membership) return membership;
  const index = originIndex();
  const map = new Map<string, Set<string>>();
  const add = (code: string, metro: string) => {
    const upper = code.toUpperCase();
    let set = map.get(upper);
    if (!set) map.set(upper, (set = new Set()));
    set.add(metro);
  };
  for (const place of index.byId.values()) {
    const metro = place.metro?.toUpperCase();
    // Only the place that OWNS the metro code — its anchor city — defines
    // the metro. Neighbours that carry the same metro code have their own
    // nearby lists, which reach well past it (Southend's includes Gatwick).
    if (!metro || index.iata.get(metro) !== place.id) continue;
    add(metro, metro);
    for (const airport of place.airports) {
      if (airport.servesPlace) add(airport.iata, metro);
    }
  }
  membership = map;
  return map;
}
