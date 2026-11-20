/**
 * Duffel's test-mode airline, shared by flights.ts (each search) and the
 * optimizer (home flights merged from several searches). A module of its own
 * so tests that mock flights.ts still get the real rule.
 */

/** Duffel's fictional test-mode airline ("Duffel Airways", IATA ZZ). */
export function isDuffelTestAirline(offer: { carrier?: string; carrierCode?: string }): boolean {
  return String(offer.carrierCode ?? '').toUpperCase() === 'ZZ' || /^duffel airways$/i.test(String(offer.carrier ?? '').trim());
}

/**
 * A Duffel TEST-mode placeholder schedule: offers sold under real airline
 * names (British Airways, American Airlines, Iberia) that depart at exactly
 * 00:00:00, name no aircraft on any segment, and carry a computed `distance`.
 * Production, 2026-11-17: Paris → London's cheapest offers were "British
 * Airways" / "American Airlines" CDG → BQH (Biggin Hill) 00:00 → 00:00, and
 * the home-flight card showed 00:00 → 00:00 at $164; New York → Paris had
 * three more (00:00 → 14:21). Sampled over 8 routes / 1,232 offers: all 5
 * placeholders match, no real offer does (real offers departing at exactly
 * 00:00:00 with no aircraft and a distance: 0).
 */
export function isDuffelPlaceholderSchedule(raw: any): boolean {
  const segments: any[] = raw?.slices?.[0]?.segments ?? [];
  if (segments.length === 0) return false;
  return (
    /T00:00:00$/.test(String(segments[0]?.departing_at ?? '')) &&
    segments.every((s) => !s?.aircraft) &&
    segments.some((s) => s?.distance != null && s?.distance !== '')
  );
}

/** The test airline, or a placeholder schedule (needs the Duffel offer as `raw`). */
export function isDuffelTestOffer(offer: { carrier?: string; carrierCode?: string; raw?: any }): boolean {
  return isDuffelTestAirline(offer) || isDuffelPlaceholderSchedule(offer.raw);
}

/**
 * `offers` without Duffel's test-mode offers (its airline, or a placeholder
 * schedule) whenever a real one is among them; all of them when test offers
 * are all there is, so the leg keeps a price. searchFlights applies it to each search. A caller that
 * merges several searches applies it again to the merged list: home flights
 * from ORD and MDW are two searches, and MDW's test-airline fare (all MDW has
 * in test mode) would otherwise undercut ORD's real ones and be what the
 * traveller sees.
 */
export function withoutTestAirlineWhenRealOffered<T>(
  offers: T[],
  carrierOf: (offer: T) => { carrier?: string; carrierCode?: string; raw?: any },
): T[] {
  const real = offers.filter((o) => !isDuffelTestOffer(carrierOf(o)));
  return real.length > 0 ? real : offers;
}
