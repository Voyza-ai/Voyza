import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip, searchActivities, searchHotels, searchRestaurants } from '@/lib/api';

/**
 * The per-city AI calls (activities, restaurants — 6.9-8.4s each in
 * production) start alongside the hotel searches instead of after the last
 * hotel batch. They never depended on hotels; they only waited for them.
 *
 * /results no longer waits for them either: it opens once the hotels are in,
 * and the picks land on the trip in the store when they answer.
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedActivities = searchActivities as jest.MockedFunction<typeof searchActivities>;
const mockedRestaurants = searchRestaurants as jest.MockedFunction<typeof searchRestaurants>;

const staged = {
  destinations: ['Paris', 'Zurich', 'London'],
  dateRange: { start: '2027-01-10', end: '2027-01-17' },
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  planningMode: 'destination' as const,
};

const optimizeResult = {
  routes: [],
  bestRoute: { ordering: ['Paris', 'Zurich', 'London'], totalCost: 0, legs: [{}, {}] },
  savingsVsNaive: 0,
  iataCodes: {},
  dates: {
    Paris: { arrival: '2027-01-10', departure: '2027-01-13' },
    Zurich: { arrival: '2027-01-13', departure: '2027-01-15' },
    London: { arrival: '2027-01-15', departure: '2027-01-17' },
  },
} as any;

/** A promise the test resolves by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const hotel = (name: string) => ({
  id: name, name, price: 600, pricePerNight: 200, currency: 'USD', rating: 8.4,
  reviewCount: 900, stars: 4, thumbnail: '', bookingUrl: '', amenities: [],
});

let hotelCalls: Record<string, ReturnType<typeof deferred<any[]>>>;
let activityCalls: Record<string, ReturnType<typeof deferred<any[]>>>;
let restaurantCalls: Record<string, ReturnType<typeof deferred<any[]>>>;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null, tripPicks: null });
  hotelCalls = {};
  activityCalls = {};
  restaurantCalls = {};
  mockedOptimize.mockResolvedValue(optimizeResult);
  mockedHotels.mockImplementation(({ city }) => (hotelCalls[city] = deferred<any[]>()).promise);
  mockedActivities.mockImplementation(({ city }) => (activityCalls[city] = deferred<any[]>()).promise);
  mockedRestaurants.mockImplementation(({ city }) => (restaurantCalls[city] = deferred<any[]>()).promise);
});

afterEach(() => window.history.pushState({}, '', '/'));

function start() {
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
  render(<PlanningChat />);
}

const resolveAll = async (calls: Record<string, ReturnType<typeof deferred<any[]>>>, rows: (city: string) => any[]) => {
  await act(async () => {
    for (const [city, d] of Object.entries(calls)) d.resolve(rows(city));
  });
};

it('starts every activities and restaurants call while the first hotel batch is still out', async () => {
  start();
  await waitFor(() => expect(Object.keys(hotelCalls)).toEqual(['Paris', 'Zurich']));

  // No hotel has answered, and all six AI calls are already in flight.
  expect(Object.keys(activityCalls).sort()).toEqual(['London', 'Paris', 'Zurich']);
  expect(Object.keys(restaurantCalls).sort()).toEqual(['London', 'Paris', 'Zurich']);
  expect(mockedActivities.mock.calls.find((c) => c[0].city === 'Paris')![0].nights).toBe(3);
});

it('keeps "Finding hotels..." until the hotels are in, even when the AI answers first', async () => {
  start();
  await waitFor(() => expect(Object.keys(activityCalls)).toHaveLength(3));
  expect(screen.getByText('Finding hotels...')).toBeInTheDocument();

  await resolveAll(activityCalls, (c) => [{ name: `${c} museum` }]);
  await resolveAll(restaurantCalls, (c) => [{ name: `${c} bistro`, cuisine: 'French', priceRange: '$$' }]);
  expect(screen.getByText('Finding hotels...')).toBeInTheDocument();
  expect(mockPush).not.toHaveBeenCalled();

  await resolveAll(hotelCalls, (c) => [hotel(`${c} hotel`)]); // Paris, Zurich
  await waitFor(() => expect(hotelCalls.London).toBeDefined());
  await resolveAll({ London: hotelCalls.London }, () => [hotel('London hotel')]);

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  const trip = useTripStore.getState().currentTrip!;
  expect(trip.cities.map((c) => [c.name, c.hotel.name, c.activities[0], c.restaurants[0]?.name])).toEqual([
    ['Paris', 'Paris hotel', 'Paris museum', 'Paris bistro'],
    ['Zurich', 'Zurich hotel', 'Zurich museum', 'Zurich bistro'],
    ['London', 'London hotel', 'London museum', 'London bistro'],
  ]);
});

it('opens /results once the hotels are in, with the AI picks still out; they land on the trip on screen', async () => {
  start();
  await waitFor(() => expect(Object.keys(hotelCalls)).toHaveLength(2));
  await resolveAll(hotelCalls, (c) => [hotel(`${c} hotel`)]);
  await waitFor(() => expect(hotelCalls.London).toBeDefined());
  await resolveAll({ London: hotelCalls.London }, () => [hotel('London hotel')]);

  // No AI call has answered, and the trip is already on its way to /results.
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  expect(screen.queryByText('Finding things to do & places to eat...')).not.toBeInTheDocument();
  let trip = useTripStore.getState().currentTrip!;
  expect(trip.cities.map((c) => [c.hotel.name, c.activities.length, c.restaurants.length])).toEqual([
    ['Paris hotel', 0, 0],
    ['Zurich hotel', 0, 0],
    ['London hotel', 0, 0],
  ]);
  // Every city has its schedule (the transport blocks), as when the AI returns nothing.
  expect(trip.cities.every((c) => c.schedule && typeof c.schedule === 'object')).toBe(true);
  expect(useTripStore.getState().tripPicks!.pending.map((r) => r.city)).toEqual(['Paris', 'Zurich', 'London']);

  // The traveller swaps Paris's hotel while the picks load.
  act(() => useTripStore.getState().updateCity(0, { hotel: hotel('Paris swapped') as any }));

  await resolveAll(activityCalls, (c) => [
    { name: `${c} museum`, category: 'museum', timeOfDay: 'morning', durationHours: 2, reason: '' },
  ]);
  await resolveAll(restaurantCalls, (c) => [
    { name: `${c} bistro`, cuisine: 'French', priceRange: '$$', mealType: 'dinner', reason: '' },
  ]);
  await waitFor(() => expect(useTripStore.getState().tripPicks!.pending).toEqual([]));

  trip = useTripStore.getState().currentTrip!;
  expect(trip.cities.map((c) => [c.hotel.name, c.activities[0], c.restaurants[0]?.name])).toEqual([
    ['Paris swapped', 'Paris museum', 'Paris bistro'],
    ['Zurich hotel', 'Zurich museum', 'Zurich bistro'],
    ['London hotel', 'London museum', 'London bistro'],
  ]);
  // ...and on its schedule, built by the same scheduler as before.
  const titles = Object.values(trip.cities[0].schedule!).flat().map((e) => e.title);
  expect(titles.some((t) => t.includes('Paris museum'))).toBe(true);
});
