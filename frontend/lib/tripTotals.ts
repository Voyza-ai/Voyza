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

/** Sum of all transport costs (transportOut for each city). */
export function transportTotal(trip: Trip): number {
  return trip.cities.reduce((sum, c) => sum + (c.transportOut?.price ?? 0), 0);
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
