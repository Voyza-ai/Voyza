import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import ResultsHeader from '@/components/results/ResultsHeader';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip, searchHotels } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import type { Trip } from '@/lib/types';

/**
 * A freshly planned trip's `totalCost` is the whole trip, not just its
 * transport.
 *
 * `buildTripFromOptimize` sets `totalCost` from the optimizer's route, which
 * is transport only — hotels aren't searched yet at that point — and nothing
 * updated it after they were. Three readers treat it as the trip total:
 *
 *  - ResultsHeader: `baseline = totalCost + savings`, `liveSavings =
 *    max(0, baseline - liveTripTotal)`. liveTripTotal includes hotels, so the
 *    savings clamped to 0 and EVERY fresh trip read "PRICE CHECK · Best price
 *    for these dates" — while the AI said the routing saved $109. Saved and
 *    reloaded, the same trip said "YOU CAN SAVE $109", because the save
 *    payload stores `liveTripTotal`.
 *  - BudgetOverBanner compared the budget against transport alone.
 *  - The AI's trip summary quoted "current routing costs $446 total" while the
 *    header said $1,351.
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;

const staged = {
  destinations: ['Paris', 'London'],
  dateRange: { start: '2027-01-10', end: '2027-01-15' },
  travelers: 6,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  planningMode: 'destination' as const,
};

const leg = (price: number) => ({
  originAirport: 'X', destAirport: 'Y', price, currency: 'USD', durationMinutes: 420,
  operator: 'Air', carrierCode: 'AA', departTime: '18:00', arriveTime: '07:00',
  departDate: '2027-01-10', stops: 0, bookingUrl: null,
});

// Transport only: a $140 Paris→London train, $2,100 out and $1,950 home.
const optimizeResult = {
  routes: [],
  bestRoute: {
    ordering: ['Paris', 'London'],
    totalCost: 140 + 2100 + 1950,
    legs: [{ options: [{ mode: 'train', operator: 'Eurostar', duration: '2h 16m', price: 140 }] }],
  },
  savingsVsNaive: 109,
  iataCodes: {},
  dates: {
    Paris: { arrival: '2027-01-10', departure: '2027-01-13' },
    London: { arrival: '2027-01-13', departure: '2027-01-15' },
  },
  outboundLeg: leg(2100),
  returnLeg: leg(1950),
} as any;

const hotel = (name: string, pricePerNight: number) => ({
  id: name, name, price: pricePerNight * 3, pricePerNight, currency: 'USD', rating: 8.4,
  reviewCount: 900, stars: 4, thumbnail: '', bookingUrl: '', amenities: [],
});

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
  let id = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++id);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null, priceMode: 'total' });
  mockedOptimize.mockResolvedValue(optimizeResult);
  mockedHotels.mockImplementation(async ({ city }) =>
    city === 'Paris' ? [hotel('Mercure Tour Eiffel', 601.26)] : [hotel('hub London', 327.33)],
  );
});

afterEach(() => window.history.pushState({}, '', '/'));

async function planFreshTrip(): Promise<Trip> {
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
  render(<PlanningChat />);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  return useTripStore.getState().currentTrip as Trip;
}

it('carries the whole trip — hotels included — as its total', async () => {
  const trip = await planFreshTrip();

  // 601.26 × 3 + 327.33 × 2 + 140 + 2100 + 1950
  expect(liveTripTotal(trip)).toBe(Math.round(601.26 * 3 + 327.33 * 2 + 140 + 2100 + 1950));
  expect(trip.totalCost).toBe(liveTripTotal(trip));
  expect(trip.savings).toBe(109);
});

it('a fresh trip shows the routing saving, the same as it will after save and reload', async () => {
  const trip = await planFreshTrip();
  render(<ResultsHeader trip={trip} />);

  expect(screen.getByText(/You can save/i)).toBeInTheDocument();
  expect(screen.getByText(/vs default routing/i)).toBeInTheDocument();
  expect(screen.queryByText(/Best price/i)).toBeNull();
});
