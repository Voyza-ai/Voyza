// Price optimization logic — placeholder for future implementation
// Will contain the multi-city route ordering algorithm and
// flight vs train comparison logic

import { City, Trip } from './types';

/**
 * Calculates the total transport cost for a trip
 */
export function calculateTransportCost(cities: City[]): number {
  return cities.reduce((total, city) => {
    return total + city.transportIn.price + city.transportOut.price;
  }, 0);
}

/**
 * Calculates the total accommodation cost for a trip
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
 * Calculates the total trip cost
 */
export function calculateTotalCost(trip: Trip): number {
  return calculateTransportCost(trip.cities) + calculateHotelCost(trip.cities);
}
