import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip, searchHotels } from '@/lib/api';
import { effectiveHotel } from '@/lib/tripTotals';

/**
 * A city whose hotel search came back empty keeps the placeholder that
 * `buildTripFromOptimize` puts there — `{ name: '', pricePerNight: 0 }` — and
 * the results card shows a nameless "$0/night" hotel that adds $0 to the
 * total.
 *
 * The common way to get there with a budget is the planner's own cap: 40% of
 * the budget spread over the nights, sent as `maxPrice`. With the party now
 * priced for every room it needs, a group's stays cost more and a tight
 * budget can leave nothing under it. A hotel over budget is a real answer the
 * budget banner can speak to; a $0 hotel is not, so the planner asks once
 * more without the cap.
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;

const staged = (extra: Record<string, unknown>) => ({
  destinations: ['Paris'],
  dateRange: { start: '2027-01-10', end: '2027-01-13' },
  travelers: 6,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  planningMode: 'destination' as const,
  ...extra,
});

const optimizeResult = {
  routes: [],
  bestRoute: { ordering: ['Paris'], totalCost: 0, legs: [] },
  savingsVsNaive: 0,
  iataCodes: {},
  dates: { Paris: { arrival: '2027-01-10', departure: '2027-01-13' } },
} as any;

const mercure = {
  id: '51086', name: 'Mercure Tour Eiffel Grenelle', price: 1803.78, pricePerNight: 601.26,
  currency: 'USD', rating: 8.1, reviewCount: 1038, stars: 4, thumbnail: '', bookingUrl: '', amenities: [],
};

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  mockedOptimize.mockResolvedValue(optimizeResult);
});

afterEach(() => window.history.pushState({}, '', '/'));

async function plan(answers: Record<string, unknown>) {
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged(answers)));
  render(<PlanningChat />);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  return useTripStore.getState().currentTrip!;
}

it('asks again without the cap when nothing came back under it', async () => {
  // $2,000 total for six: the cap is 40% over 3 nights = $266/night, and the
  // cheapest Paris stay for three rooms is $391/night.
  mockedHotels.mockImplementation(async (p) => (p.maxPrice !== undefined ? [] : [mercure]));

  const trip = await plan({ budget: 2000, budgetPerPerson: false });

  expect(mockedHotels).toHaveBeenCalledTimes(2);
  expect(mockedHotels.mock.calls[0][0].maxPrice).toBe(266 * 3);
  expect(mockedHotels.mock.calls[1][0]).not.toHaveProperty('maxPrice');
  expect(mockedHotels.mock.calls[1][0]).toMatchObject({ city: 'Paris', adults: 6 });

  const paris = trip.cities[0];
  expect(paris.hotel.name).toBe('Mercure Tour Eiffel Grenelle');
  expect(effectiveHotel(paris).total).toBeCloseTo(601.26 * 3);
});

it('does not ask twice when the capped search found hotels', async () => {
  mockedHotels.mockResolvedValue([mercure]);
  await plan({ budget: 20000, budgetPerPerson: false });
  expect(mockedHotels).toHaveBeenCalledTimes(1);
});

it('does not repeat an uncapped search that came back empty', async () => {
  // No budget, so no cap: the same request again would be the same answer.
  mockedHotels.mockResolvedValue([]);
  const trip = await plan({});

  expect(mockedHotels).toHaveBeenCalledTimes(1);
  // What the user still sees in this case: the placeholder. Reported, not
  // redesigned here — an empty-hotel state is a UI change.
  expect(trip.cities[0].hotel).toMatchObject({ name: '', pricePerNight: 0 });
});
