import type { HotelResult } from './api';
import type { Hotel } from './types';

/**
 * `HotelResult` (what the provider gives us) → `Hotel` (what a trip stores).
 *
 * One function because there were FOUR copies of this mapping — the results
 * page, PlanningChat, the canvas page and the backend's canvas route — and
 * every one of them copied the same five fields and dropped the rest. That is
 * how `priceSuspect` came to be added to the `Hotel` type and then be
 * permanently `undefined` in production: the price verdict died at this
 * boundary, so it never reached the store, never survived the JSONB round trip,
 * and no UI could warn on it. `reviewCount` went the same way, which meant any
 * re-rank took a 9.5-from-3-reviews at face value.
 *
 * Four copies is four places to forget the next field.
 *
 * IN ITS OWN MODULE, and both imports are type-only, on purpose. Living in
 * `api.ts` made it a casualty of `src/__tests__/mocks.ts`, which replaces that
 * whole module with an explicit list of exports — so this came back
 * `undefined`, `results.map(undefined)` threw inside the enrichment promise,
 * and the failure surfaced as a city silently keeping its old hotel. A pure
 * mapping has no business being mockable. Type-only imports are erased, so
 * nothing here pulls `api.ts` in at runtime.
 *
 * The backend's canvas route keeps its own copy by necessity — different
 * package — so that one is still manual.
 */
export function hotelFromResult(r: HotelResult): Hotel {
  return {
    name: r.name,
    rating: r.rating,
    pricePerNight: r.pricePerNight,
    area: '',
    bookingUrl: r.bookingUrl,
    reviewCount: r.reviewCount,
    priceSuspect: r.priceSuspect,
  };
}
