/**
 * A new plan whose short hop has no sensible flight (backend compareLeg
 * `noSensibleFlight`: Prague → Vienna with only 22h+ connections, no train)
 * never puts the 22-hour flight on the card. The card is the existing "no
 * direct option" one, saying "No sensible flight" with a ground ESTIMATE —
 * never a fare — and the fastest flight's length.
 */
import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import Connector from '@/components/results/Connector';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip, searchHotels } from '@/lib/api';
import type { Trip } from '@/lib/types';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;

const staged = {
  destinations: ['Prague', 'Vienna'],
  dateRange: { start: '2026-12-23', end: '2026-12-31' },
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  planningMode: 'destination' as const,
};
const home = (price: number) => ({
  originAirport: 'JFK', destAirport: 'PRG', price, currency: 'USD', durationMinutes: 540,
  operator: 'Air', carrierCode: 'AA', departTime: '18:00', arriveTime: '08:00', departDate: '2026-12-23', stops: 0, bookingUrl: null,
});
const LONG = { mode: 'flight', operator: 'LOT', duration: '22h 50m', durationMinutes: 1370, price: 301, departTime: '18:00', arriveTime: '16:50', stops: 2 };
const FLAG = { fastestMinutes: 1370, stops: 2, groundHours: [4, 5] as [number, number] };

const result = (flag: boolean) =>
  ({
    routes: [],
    bestRoute: {
      ordering: ['Prague', 'Vienna'],
      totalCost: 301 + 500 + 480,
      legs: [{
        options: [LONG],
        comparison: { flightOption: { carrier: 'LOT', price: 301, durationMinutes: 1370 }, trainOption: null, recommendation: 'flight', ...(flag ? { noSensibleFlight: FLAG } : {}) },
      }],
    },
    savingsVsNaive: 0,
    iataCodes: {},
    dates: { Prague: { arrival: '2026-12-24', departure: '2026-12-27' }, Vienna: { arrival: '2026-12-27', departure: '2026-12-31' } },
    outboundLeg: home(500),
    returnLeg: { ...home(480), originAirport: 'VIE', destAirport: 'JFK' },
  }) as any;

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
  mockedHotels.mockResolvedValue([]);
});
afterEach(() => window.history.pushState({}, '', '/'));

async function plan(flag: boolean): Promise<Trip> {
  mockedOptimize.mockResolvedValue(result(flag));
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
  render(<PlanningChat />);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  return useTripStore.getState().currentTrip as Trip;
}

it('Prague → Vienna with no sensible flight: the card is not the 22-hour flight; it says so, with a ground estimate', async () => {
  const trip = await plan(true);
  const leg = trip.cities[0].transportOut;
  expect(leg).toMatchObject({ unavailable: true, price: 0, noSensibleFlight: FLAG });
  render(<Connector transport={leg} index={0} cityIndex={0} isExpanded={false} onToggle={() => {}} />);
  expect(screen.getByText('No sensible flight')).toBeInTheDocument();
  expect(screen.getByTestId('no-sensible-flight')).toHaveTextContent('About 4–5 h by train or bus (estimate)');
  expect(screen.getByTestId('no-sensible-flight')).toHaveTextContent('Fastest flight 22h 50m');
  expect(document.body.textContent).not.toMatch(/\$301/);
});

it('an unflagged leg is planned as before (control)', async () => {
  const trip = await plan(false);
  expect(trip.cities[0].transportOut).toMatchObject({ operator: 'LOT', price: 301 });
  expect(trip.cities[0].transportOut.unavailable).toBeFalsy();
});
