// Price optimization logic — calls backend /api/optimize when available,
// falls back to local calculation for display purposes.

import { City, Trip } from './types';
import { optimizeTrip, OptimizeResult } from './api';

/**
 * Calculates the total transport cost for a trip (local computation)
 */
export function calculateTransportCost(cities: City[]): number {
  return cities.reduce((total, city) => {
    return total + city.transportIn.price + city.transportOut.price;
  }, 0);
}

/**
 * Calculates the total accommodation cost for a trip (local computation)
 */
export function calculateHotelCost(cities: City[]): number {
  return cities.reduce((total, city) => {
    const arrival = new Date(city.dates.arrival);
    const departure = new Date(city.dates.departure);
    const nights = Math.ceil(
      (departure.getTime() - arrival.getTime()) / (1000 * 60 * 60 * 24)
    );
    return total + city.hotel.pricePerNight * nights;
  }, 0);
}

/**
 * Calculates the total trip cost (local computation)
 */
export function calculateTotalCost(trip: Trip): number {
  return calculateTransportCost(trip.cities) + calculateHotelCost(trip.cities);
}

/**
 * Calls the backend optimizer for multi-city route optimization.
 * Falls back gracefully if the backend is unavailable.
 */
export async function optimizeRoute(
  cities: Array<{ name: string; country?: string }>,
  startDate: string,
  travelers: number,
  budget?: number,
): Promise<OptimizeResult | null> {
  try {
    return await optimizeTrip({ cities, startDate, travelers, budget });
  } catch {
    return null;
  }
}
