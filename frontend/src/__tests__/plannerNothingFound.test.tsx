/**
 * A new plan whose hop has NOTHING bookable — no train, no flight — (live
 * 2026-11-23, "Plan a similar trip" on the Lisbon & Sintra Escape preset:
 * All Aboard has no CP trains and nothing flies Lisbon → Sintra). When the
 * backend sends a ground estimate (compareLeg `groundEstimate`, only for a
 * close hop over land) the card says "Not bookable here, about
 * 35–45 min by train or bus (estimate)" and the banner says the leg is not in
 * the total. A far hop has none and stays "No direct option".
 */
import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { liveTripTotal } from '@/lib/tripTotals';
import PlanningChat from '@/components/planning/PlanningChat';
import Connector from '@/components/results/Connector';
import MissingPricesNotice, { estimatedLegNotes, missingPriceParts } from '@/components/results/MissingPricesNotice';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip, searchHotels } from '@/lib/api';
import type { Trip } from '@/lib/types';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;

const ESTIMATE = { minutes: [35, 45] as [number, number], km: 22 };

const home = (price: number, dest: string) => ({
  originAirport: 'JFK', destAirport: dest, price, currency: 'USD', durationMinutes: 420,
  operator: 'Air', carrierCode: 'AA', departTime: '18:00', arriveTime: '06:00', departDate: '2026-12-23', stops: 0, bookingUrl: null,
});

const result = (to: string, estimate: boolean) =>
  ({
    routes: [],
    bestRoute: {
      ordering: ['Lisbon', to],
      totalCost: 500 + 480,
      legs: [{
        options: [],
        comparison: {
          flightOption: null, trainOption: null, cheapest: 'unavailable', fastest: 'unavailable', recommendation: 'unavailable',
          priceDifference: 0, timeDifference: 0, ...(estimate ? { groundEstimate: ESTIMATE } : {}),
        },
      }],
    },
    savingsVsNaive: 0,
    iataCodes: {},
    dates: { Lisbon: { arrival: '2026-12-24', departure: '2026-12-27' }, [to]: { arrival: '2026-12-27', departure: '2026-12-31' } },
    outboundLeg: home(500, 'LIS'),
    returnLeg: { ...home(480, 'LIS'), originAirport: 'LIS', destAirport: 'JFK' },
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

async function plan(to: string, estimate: boolean): Promise<Trip> {
  mockedOptimize.mockResolvedValue(result(to, estimate));
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem(
    'bluemurr-autorun',
    JSON.stringify({
      destinations: ['Lisbon', to], dateRange: { start: '2026-12-23', end: '2026-12-31' }, travelers: 2,
      origin: 'New York', originAirports: ['JFK'], returnToHome: true, planningMode: 'destination',
    }),
  );
  render(<PlanningChat />);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  return useTripStore.getState().currentTrip as Trip;
}

it('Lisbon → Sintra with nothing bookable: the card gives a train-or-bus estimate, no fare', async () => {
  const trip = await plan('Sintra', true);
  const leg = trip.cities[0].transportOut;
  expect(leg).toMatchObject({ unavailable: true, price: 0, groundEstimate: ESTIMATE });
  render(<Connector transport={leg} index={0} cityIndex={0} isExpanded={false} onToggle={() => {}} />);
  expect(screen.getByText('Not bookable here')).toBeInTheDocument();
  expect(screen.getByTestId('ground-estimate-icon')).toBeInTheDocument();
  expect(screen.getByTestId('ground-estimate')).toHaveTextContent('About 35–45 min by train or bus (estimate)');
  expect(screen.queryByText(/\$\d/)).toBeNull();
});

it('the total leaves the estimated leg out, and the banner says so in one line', async () => {
  const trip = await plan('Sintra', true);
  // Home flights $500 + $480 only: the estimate adds nothing.
  expect(liveTripTotal(trip)).toBe(980);
  expect(missingPriceParts(trip)).not.toContain('a way from Lisbon to Sintra');
  expect(estimatedLegNotes(trip)).toEqual([
    'Lisbon → Sintra isn\'t bookable here: about 35–45 min by train or bus (estimate), not in the total.',
  ]);
  render(<MissingPricesNotice trip={trip} />);
  // A routine hop: a neutral info line, not the warning triangle (the warning
  // here is only for the hotels this test trip has none of).
  const note = screen.getByTestId('estimated-leg-note');
  expect(note.querySelector('svg.lucide-info')).not.toBeNull();
  expect(note.querySelector('svg.lucide-triangle-alert')).toBeNull();
  expect(screen.getByTestId('missing-prices-warning')).not.toHaveTextContent('a way from Lisbon to Sintra');
  expect(screen.getByTestId('missing-prices-notice')).toHaveTextContent(
    'Lisbon → Sintra isn\'t bookable here: about 35–45 min by train or bus (estimate), not in the total.',
  );
});

it('a far hop with nothing found (no estimate) stays "No direct option"', async () => {
  const trip = await plan('Berlin', false);
  const leg = trip.cities[0].transportOut;
  expect(leg.unavailable).toBe(true);
  expect(leg.groundEstimate).toBeUndefined();
  render(<Connector transport={leg} index={0} cityIndex={0} isExpanded={false} onToggle={() => {}} />);
  expect(screen.getByText('No direct option')).toBeInTheDocument();
  expect(screen.queryByTestId('ground-estimate-icon')).toBeNull();
  expect(screen.queryByTestId('ground-estimate')).toBeNull();
  expect(missingPriceParts(trip)).toContain('a way from Lisbon to Berlin');
  expect(estimatedLegNotes(trip)).toEqual([]);
  // Nothing found and nothing to estimate: still the warning.
  render(<MissingPricesNotice trip={trip} />);
  expect(screen.getByTestId('missing-prices-warning').querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).not.toBeNull();
});
