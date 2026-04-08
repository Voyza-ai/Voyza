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

/** Sum of all hotel totals across the trip. */
export function hotelsTotal(trip: Trip): number {
  return trip.cities.reduce((sum, c) => sum + effectiveHotel(c).total, 0);
}

/** Sum of all transport costs (transportOut for each city). */
export function transportTotal(trip: Trip): number {
  return trip.cities.reduce((sum, c) => sum + (c.transportOut?.price ?? 0), 0);
}

/** Live trip total = hotels + transport, multiplied by traveler count. */
export function liveTripTotal(trip: Trip): number {
  const perPerson = hotelsTotal(trip) + transportTotal(trip);
  return Math.round(perPerson * trip.travelers);
}
