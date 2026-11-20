import type { City, Hotel, Trip } from './types';

/**
 * What we can say about a hotel price we cannot stand behind. Two different
 * claims, kept apart on purpose:
 *
 *  - `suspect`: the backend compared the price with the rest of its search
 *    and it is out of line (`priceSuspect`). Such a row is never auto-picked
 *    (`trustedFirst` / `rankHotels` sort it last), so a traveller only meets
 *    one by choosing it — and then they must be told.
 *  - `unverified`: the search was too thin to compare anything
 *    (`priceUnverified`) — one row cannot be an outlier of itself. The price
 *    is most likely real (Val d'Isère: a 9.6 hotel at $3,377.84/night in peak
 *    ski week), so it stays in the trip total; we only say we couldn't check.
 *
 * A suspect verdict wins when a row carries both.
 */
export type PriceTrust = {
  kind: 'suspect' | 'unverified';
  /** A few words for a chip. */
  label: string;
  /** One or two sentences: why, and what to do. */
  detail: string;
};

type Flags = Pick<Hotel, 'priceSuspect' | 'priceSuspectReason' | 'priceUnverified'>;

export function hotelPriceTrust(
  hotel: Flags | null | undefined,
  ctx: { travelers?: number; hotelsInSearch?: number } = {},
): PriceTrust | null {
  if (!hotel) return null;
  if (hotel.priceSuspect) {
    const reason = hotel.priceSuspectReason ?? '';
    if (reason === 'below-tier-median') {
      return {
        kind: 'suspect',
        label: 'Price looks low',
        detail: 'Far below similar hotels in this search, so the rate you are charged may be higher. Check it on the booking site.',
      };
    }
    if (reason === 'occupancy-short') {
      const n = ctx.travelers && ctx.travelers > 1 ? `all ${ctx.travelers} travelers` : 'everyone';
      return {
        kind: 'suspect',
        label: 'Room may be too small',
        detail: `This rate may not cover ${n}. Check the room on the booking site.`,
      };
    }
    if (reason.startsWith('above-')) {
      return {
        kind: 'suspect',
        label: 'Price looks high',
        detail: 'Far above similar hotels in this search; it may be a provider error. Check the rate on the booking site.',
      };
    }
    return {
      kind: 'suspect',
      label: 'Price looks off',
      detail: 'Out of line with similar hotels in this search. Check the rate on the booking site.',
    };
  }
  if (hotel.priceUnverified) {
    const n = ctx.hotelsInSearch;
    const found = n === 1 ? 'Only one hotel came back' : n && n > 1 ? `Only ${n} hotels came back` : 'Very few hotels came back';
    return {
      kind: 'unverified',
      label: 'Price unchecked',
      detail: `${found} for this city, so we couldn't compare this price with others. Confirm it on the booking site.`,
    };
  }
  return null;
}

/** The hotel a city's stay is priced on, unless the traveller entered their own. */
function selectedListHotel(city: City): Hotel | null {
  if (city.customHotel) return null;
  return city.hotels?.[city.selectedHotelIndex] ?? city.hotel ?? null;
}

/** A city's selected hotel's caveat, with the counts its words need. */
export function cityHotelTrust(city: City, travelers?: number): PriceTrust | null {
  return hotelPriceTrust(selectedListHotel(city), { travelers, hotelsInSearch: city.hotels?.length });
}

/**
 * Cities whose stay — as counted in the trip total — is priced on a hotel we
 * flag. A traveller's own hotel is their number, never flagged.
 */
export function tripPriceCaveats(trip: Pick<Trip, 'cities' | 'travelers'>): {
  suspect: string[];
  unverified: string[];
} {
  const suspect: string[] = [];
  const unverified: string[] = [];
  for (const city of trip.cities) {
    const t = cityHotelTrust(city, trip.travelers);
    if (t?.kind === 'suspect') suspect.push(city.name);
    else if (t?.kind === 'unverified') unverified.push(city.name);
  }
  return { suspect, unverified };
}
