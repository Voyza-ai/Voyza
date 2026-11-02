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
 * `offers` without Duffel's test-mode airline whenever a real airline is
 * among them; all of them when the test airline is all there is, so the leg
 * keeps a price. searchFlights applies it to each search. A caller that
 * merges several searches applies it again to the merged list: home flights
 * from ORD and MDW are two searches, and MDW's test-airline fare (all MDW has
 * in test mode) would otherwise undercut ORD's real ones and be what the
 * traveller sees.
 */
export function withoutTestAirlineWhenRealOffered<T>(
  offers: T[],
  carrierOf: (offer: T) => { carrier?: string; carrierCode?: string },
): T[] {
  const real = offers.filter((o) => !isDuffelTestAirline(carrierOf(o)));
  return real.length > 0 ? real : offers;
}
