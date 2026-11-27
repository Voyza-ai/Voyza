/**
 * The trip total the results header shows is the sum of the cards.
 *
 * The fixture is a real optimizer answer: New York -> Paris, Berlin,
 * Amsterdam on 2027-01-12 for 2, replayed from recorded Duffel and All Aboard
 * answers on dev's backend. In it, bestRoute.totalCost ($1,094.63) counts a
 * $102.35 Paris-Berlin flight while the leg's card (options[0]) is an $87.70
 * train. The backend now totals the cards itself (optimizerTotalMatchesCards
 * on the backend); this pins the frontend side: the planner's trip takes its
 * total from the cards, never from bestRoute.totalCost.
 */
import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { optimizeTrip } from '@/lib/api';
import { liveTripTotal, transportTotal } from '@/lib/tripTotals';
import { useTripStore } from '@/store/tripStore';
import recorded from './fixtures/optimize-paris-berlin-amsterdam.json';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});
beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
});
afterEach(() => {
  window.history.pushState({}, '', '/');
  sessionStorage.clear();
});

it('the planned trip totals its cards, not the optimizer’s own number', async () => {
  mockedOptimize.mockResolvedValue(recorded as any);
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem(
    'bluemurr-autorun',
    JSON.stringify({
      destinations: ['Paris', 'Berlin', 'Amsterdam'],
      dateRange: { start: '2027-01-12', end: '2027-01-19' },
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK', 'EWR', 'LGA'],
      returnToHome: true,
      planningMode: 'destination',
    }),
  );
  render(<PlanningChat />);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/^\/results/)), { timeout: 15000 });

  const trip = useTripStore.getState().currentTrip!;
  const cards = trip.cities.slice(0, -1).map((c) => [c.transportOut.mode, c.transportOut.price]);
  expect(cards).toEqual([
    ['train', 87.7],
    ['train', 95.38],
  ]);
  expect(trip.origin?.outboundLeg?.price).toBe(447);
  expect(trip.origin?.returnLeg?.price).toBe(449.9);

  // No hotels in this test, so the total is the transport on the cards.
  expect(transportTotal(trip)).toBeCloseTo(1079.98, 2);
  expect(trip.totalCost).toBe(1080);
  expect(trip.totalCost).toBe(liveTripTotal(trip));
  expect(Math.round(recorded.bestRoute.totalCost)).not.toBe(trip.totalCost);
}, 20000);
