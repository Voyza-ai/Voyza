import { rankHotels } from './hotelScore';
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

/**
 * Re-rank one city's saved hotels on load, preserving the traveller's own pick.
 *
 * Trips already in the database were never re-ranked or re-flagged when read
 * back: `getTrip` does not rank, `tripShape.ts` does not re-sort, and the
 * canvas route skips its re-search when a city already has hotels. So a trip
 * saved before the price guards existed keeps raw provider order, and its
 * `hotels[0]` — the trip's hotel and its headline total — can still be the
 * glitch row. That is the $5383.47/night Florence case, still live in saved
 * trips.
 *
 * Re-ranking fixes those without needing a flag, because the ranking formula's
 * `100 / pricePerNight` term buries an absurdly expensive row on its own —
 * which is the whole reason the over-priced direction was never the dangerous
 * one. Legacy rows carry no `priceSuspect`, and they do not need to.
 *
 * Reordering would otherwise invalidate `selectedHotelIndex`, which is a stored
 * position into the old array, so the pick is re-found by name and kept — a
 * traveller who deliberately chose the expensive resort kept it. The selection
 * only moves when the row it points at is one we would not auto-select: a
 * flagged row, or a price that cannot be real. In that case it falls to the
 * best row instead of silently keeping a number nobody can stand behind.
 */
export function rerankSavedCityHotels<
  T extends { hotels?: Hotel[] | null; selectedHotelIndex?: number; hotel?: Hotel },
>(city: T): T {
  const hotels = city.hotels;
  if (!Array.isArray(hotels) || hotels.length === 0) return city;

  const storedIndex = city.selectedHotelIndex ?? 0;
  const previous = hotels[storedIndex];
  const ranked = rankHotels(hotels);

  // Index 0 is not a choice, it is the absence of one: every path that builds a
  // city sets `selectedHotelIndex: 0` alongside `hotel = hotels[0]`, so a
  // stored 0 means "whatever the provider returned first". Only a non-zero
  // index records a traveller actually picking something.
  //
  // This distinction is what makes the repair work. On a legacy trip the
  // glitch row sits at index 0 with no `priceSuspect` to mark it — it predates
  // the flag — so treating a stored 0 as a deliberate pick would faithfully
  // re-select the $5383.47 row after ranking had correctly buried it, and the
  // headline total would not move. A deliberate pick is honoured; an inherited
  // one is re-made.
  let index = 0;
  if (storedIndex > 0 && previous?.name) {
    const moved = ranked.findIndex((h) => h.name === previous.name);
    const row = moved >= 0 ? ranked[moved] : undefined;
    const keepable =
      !!row &&
      row.priceSuspect !== true &&
      Number.isFinite(row.pricePerNight) &&
      row.pricePerNight > 0;
    if (keepable) index = moved;
  }

  return { ...city, hotels: ranked, selectedHotelIndex: index, hotel: ranked[index] };
}
