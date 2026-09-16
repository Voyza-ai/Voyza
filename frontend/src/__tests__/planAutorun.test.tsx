import './mocks';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip } from '@/lib/api';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;

// The "Cheaper start dates" menu stages shifted answers in the store and
// lands on /plan?resume=1&autorun=1 — the planner must kick the search
// immediately, no pickers, no chat steps.
describe('PlanningChat autorun (one-click date-shift replan)', () => {
  beforeAll(() => {
    // jsdom has no Element.scrollTo — the chat's autoscroll timer would
    // throw during the settle waits below.
    Element.prototype.scrollTo = jest.fn();
  });

  const stagedAnswers = {
    destinations: ['Rome', 'Florence'],
    dateRange: { start: '2026-11-10', end: '2026-11-15' },
    travelers: 2,
    origin: 'New York',
    originAirports: ['JFK'],
    returnToHome: true,
    planningMode: 'destination' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
    // Fail the search fast — these tests only assert the kickoff.
    mockedOptimize.mockRejectedValue(new Error('search stopped by test'));
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('starts the search immediately with the staged shifted dates', async () => {
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    useTripStore.setState({ answers: stagedAnswers });

    render(<PlanningChat />);
    await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));

    const call = mockedOptimize.mock.calls[0][0];
    expect(call.startDate).toBe('2026-11-10');
    expect(call.cities.map((c: any) => c.name)).toEqual(['Rome', 'Florence']);
    expect(call.travelers).toBe(2);
    expect(call.origin).toBe('New York');
  });

  it('does not autorun without the autorun param (normal resume)', async () => {
    window.history.pushState({}, '', '/plan?resume=1');
    useTripStore.setState({ answers: stagedAnswers });

    render(<PlanningChat />);
    await new Promise((r) => setTimeout(r, 80));
    expect(mockedOptimize).not.toHaveBeenCalled();
  });

  it('falls back to the normal flow when staged answers are incomplete', async () => {
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    // Missing origin → validation fails → no auto-search.
    const { origin, ...withoutOrigin } = stagedAnswers;
    useTripStore.setState({ answers: withoutOrigin });

    render(<PlanningChat />);
    await new Promise((r) => setTimeout(r, 80));
    expect(mockedOptimize).not.toHaveBeenCalled();
  });
});
