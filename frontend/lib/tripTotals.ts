import { City, Trip } from './types';
import { nightsBetween } from './hotelScore';

/**
 * Effective hotel for a city — custom hotel takes priority, otherwise the
 * currently selected entry in the ranked list.
 */
export function effectiveHotel(city: City): {
  name: string;
  pricePerNight: number;
  /** room subtotal only — pricePerNight × nights (no taxes) */
  roomSubtotal: number;
  /** taxes & fees subtotal — taxesPerNight × nights (0 if none) */
  taxesSubtotal: number;
  /** grand total = roomSubtotal + taxesSubtotal */
  total: number;
  nights: number;
  area?: string;
  rating?: number;
  isCustom: boolean;
  url?: string;
  bookable?: boolean;
  taxesPerNight?: number;
} {
  const nights = nightsBetween(city.dates.arrival, city.dates.departure);
  if (city.customHotel) {
    const c = city.customHotel;
    const pricePerNight =
      c.mode === 'perNight' ? c.amount : nights > 0 ? c.amount / nights : c.amount;
    const roomSubtotal = c.mode === 'total' ? c.amount : c.amount * nights;
    return {
      name: c.name,
      pricePerNight,
      roomSubtotal,
      taxesSubtotal: 0,
      total: roomSubtotal,
      nights,
      area: c.area,
      isCustom: true,
      url: c.url,
      bookable: false,
    };
  }
  const h = city.hotels[city.selectedHotelIndex] ?? city.hotel;
  const roomSubtotal = h.pricePerNight * nights;
  const taxesSubtotal = (h.taxesPerNight ?? 0) * nights;
  return {
    name: h.name,
    pricePerNight: h.pricePerNight,
    roomSubtotal,
    taxesSubtotal,
    total: roomSubtotal + taxesSubtotal,
    nights,
    area: h.area,
    rating: h.rating,
    isCustom: false,
    url: h.bookingUrl,
    bookable: h.bookable,
    taxesPerNight: h.taxesPerNight,
  };
}

/** Sum of all hotel totals across the trip, accounting for multi-room stays. */
export function hotelsTotal(trip: Trip): number {
  return trip.cities.reduce((sum, c) => {
    const eff = effectiveHotel(c);
    // Determine rooms needed for the group
    const hotel = c.customHotel
      ? null
      : c.hotels[c.selectedHotelIndex] ?? c.hotels[0];
    const guestsPerRoom = hotel?.maxGuests;
    const roomsNeeded = guestsPerRoom ? Math.ceil(trip.travelers / guestsPerRoom) : 1;
    return sum + eff.total * roomsNeeded;
  }, 0);
}

/**
 * Sum of all transport costs:
 *   - `transportOut` for each non-last city (inter-city legs)
 *   - `trip.origin.outboundLeg` if present (home → first city)
 *   - `trip.origin.returnLeg` if present (last city → home)
 *
 * Home legs are stored on `trip.origin`, not on the cities' transport
 * fields, so a trip with origin set would otherwise undersum here. This
 * was the bug behind the "header total doesn't match the leg prices"
 * issue — single-city vibe trips reported $0 transport because no city
 * had a transportOut to sum.
 */
export function transportTotal(trip: Trip): number {
  let sum = trip.cities.reduce(
    (s, c) => s + (c.transportOut?.price ?? 0),
    0,
  );
  if (trip.origin?.outboundLeg) {
    sum += Number(trip.origin.outboundLeg.price ?? 0);
  }
  if (trip.origin?.returnLeg) {
    sum += Number(trip.origin.returnLeg.price ?? 0);
  }
  return sum;
}

/**
 * Live trip total = hotels + transport (group total).
 *
 * Both components are already group totals:
 * - `hotelsTotal` accounts for rooms needed (one room priced per night, not
 *   per person — multi-room stays multiply via `roomsNeeded`).
 * - `transportTotal` uses Duffel / DB prices which are quoted for the whole
 *   passenger set on the booking.
 *
 * Per-person display is just `liveTripTotal / travelers` in the header.
 */
export function liveTripTotal(trip: Trip): number {
  return Math.round(hotelsTotal(trip) + transportTotal(trip));
}

/**
 * Convert a stored group-total amount into the value to actually render
 * based on the user's priceMode toggle. Every price on the results page
 * (flights, hotels, transit, totals, savings) is stored as a group total —
 * 'perPerson' simply divides by `travelers`. Centralized here so the
 * formula stays consistent; if a future price needs different framing
 * (e.g. already-per-person), branch at the call site instead of changing
 * this helper.
 */
export function displayAmount(
  amount: number,
  priceMode: 'total' | 'perPerson',
  travelers: number,
): number {
  if (priceMode === 'perPerson' && travelers > 0) {
    return Math.round(amount / travelers);
  }
  return Math.round(amount);
}
