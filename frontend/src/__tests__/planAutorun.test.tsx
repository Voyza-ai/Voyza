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
    sessionStorage.clear();
    useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
    // Fail the search fast — these tests only assert the kickoff.
    mockedOptimize.mockRejectedValue(new Error('search stopped by test'));
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    sessionStorage.clear();
  });

  it('restores from the sessionStorage snapshot even when the store was wiped and the URL is stale', async () => {
    // Reproduces the real bug: mid-navigation the plan page saw a stale
    // URL (no resume/autorun params) and reset the store — the user landed
    // on a blank intent picker. The snapshot must survive both.
    window.history.pushState({}, '', '/plan'); // stale URL: no flags at all
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify(stagedAnswers));
    // Store already wiped by the plan page's reset:
    useTripStore.setState({ answers: {} });

    render(<PlanningChat />);
    await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));

    const call = mockedOptimize.mock.calls[0][0];
    expect(call.startDate).toBe('2026-11-10');
    expect(call.cities.map((c: any) => c.name)).toEqual(['Rome', 'Florence']);
    // The snapshot is one-shot — consumed on use.
    expect(sessionStorage.getItem('bluemurr-autorun')).toBeNull();
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

  it('shows a searching state instead of the intent picker while running', async () => {
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify(stagedAnswers));
    // Search never resolves — freeze the in-flight state.
    mockedOptimize.mockReturnValue(new Promise(() => {}) as any);

    const { findByText, queryByText } = render(<PlanningChat />);
    expect(await findByText(/Searching flights, trains, and hotels|Finding the best routes/)).toBeInTheDocument();
    // Wait past the 500ms delayed greeting timer — the picker must stay away.
    await new Promise((r) => setTimeout(r, 600));
    expect(queryByText('I know where I want to go')).not.toBeInTheDocument();
  });

  it('restores the intent picker when the autorun search fails', async () => {
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify(stagedAnswers));
    // beforeEach mock: optimize rejects → error bubble → picker returns.

    const { findByText } = render(<PlanningChat />);
    expect(await findByText(/ran into a problem/)).toBeInTheDocument();
    expect(await findByText('I know where I want to go')).toBeInTheDocument();
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
