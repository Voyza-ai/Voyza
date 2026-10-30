import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import {
  optimizeTrip,
  searchActivities,
  searchHotels,
  suggestDestinationsForVibe,
} from '@/lib/api';

/**
 * A planner search the user walked away from must not land.
 *
 * The search outlives the page: leave /plan while it runs (the logo, the back
 * button) and when the optimizer answered, runOptimizeAndBuild still searched
 * hotels and AI picks, overwrote `currentTrip` with the abandoned trip and
 * pushed /results — over whatever the user had gone on to look at.
 * Reproduced by agent E (planner.audit.test.tsx, E-PLAN-UNMOUNT).
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedActivities = searchActivities as jest.MockedFunction<typeof searchActivities>;
const mockedVibe = suggestDestinationsForVibe as jest.MockedFunction<typeof suggestDestinationsForVibe>;

const staged = {
  destinations: ['Paris'],
  dateRange: { start: '2026-11-28', end: '2026-12-01' },
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  planningMode: 'destination' as const,
};

const optimizeResult = {
  routes: [],
  bestRoute: { ordering: ['Paris'], totalCost: 0, legs: [] },
  savingsVsNaive: 0,
  iataCodes: {},
  dates: { Paris: { arrival: '2026-11-28', departure: '2026-12-01' } },
} as any;

const otherTrip = { id: 'trip-the-user-is-now-looking-at', cities: [] } as any;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
});

afterEach(() => window.history.pushState({}, '', '/'));

function startAutorun(answers: Record<string, unknown>) {
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem('bluemurr-autorun', JSON.stringify(answers));
  return render(<PlanningChat />);
}

it('an abandoned search neither overwrites the trip nor navigates, nor keeps spending calls', async () => {
  let resolve!: (v: any) => void;
  mockedOptimize.mockReturnValue(new Promise((r) => (resolve = r)) as any);

  const { unmount } = startAutorun(staged);
  await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));

  unmount();
  useTripStore.setState({ currentTrip: otherTrip });

  await act(async () => {
    resolve(optimizeResult);
    await new Promise((r) => setTimeout(r, 50));
  });

  expect(mockPush).not.toHaveBeenCalled();
  expect(useTripStore.getState().currentTrip).toBe(otherTrip);
  // Hotel and AI searches are rate-limited calls; an abandoned search
  // should not spend them.
  expect(mockedHotels).not.toHaveBeenCalled();
  expect(mockedActivities).not.toHaveBeenCalled();
});

it('leaving during the hotel phase stops it too', async () => {
  mockedOptimize.mockResolvedValue(optimizeResult);
  let resolveHotels!: (v: any) => void;
  mockedHotels.mockReturnValue(new Promise((r) => (resolveHotels = r)) as any);

  const { unmount } = startAutorun(staged);
  await waitFor(() => expect(mockedHotels).toHaveBeenCalledTimes(1));

  unmount();
  useTripStore.setState({ currentTrip: otherTrip });
  await act(async () => {
    resolveHotels([]);
    await new Promise((r) => setTimeout(r, 50));
  });

  expect(mockPush).not.toHaveBeenCalled();
  expect(useTripStore.getState().currentTrip).toBe(otherTrip);
});

it('a vibe search the user left does not write its pick into the planning answers', async () => {
  let resolve!: (v: any) => void;
  mockedVibe.mockReturnValue(new Promise((r) => (resolve = r)) as any);

  const { unmount } = startAutorun({
    ...staged,
    destinations: [],
    planningMode: 'vibe',
    vibe: 'Beachy',
    budget: 3000,
  });
  await waitFor(() => expect(mockedVibe).toHaveBeenCalledTimes(1));

  unmount();
  // The user has since started planning something else.
  useTripStore.setState({ answers: { destinations: ['Lisbon'] } });

  await act(async () => {
    resolve({
      suggestions: [
        { destination_city: 'Tulum', destination_country: 'Mexico', why_it_fits_vibe: 'Beaches.' },
      ],
      reasoning_summary: '',
    });
    await new Promise((r) => setTimeout(r, 50));
  });

  expect(useTripStore.getState().answers.destinations).toEqual(['Lisbon']);
  expect(mockedOptimize).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

it('a search the user stays for still lands', async () => {
  mockedOptimize.mockResolvedValue(optimizeResult);
  mockedHotels.mockResolvedValue([]);
  startAutorun(staged);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  expect(useTripStore.getState().currentTrip!.cities[0].name).toBe('Paris');
});
