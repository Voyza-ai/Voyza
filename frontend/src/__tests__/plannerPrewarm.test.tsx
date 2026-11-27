import './mocks';
import React from 'react';
import { render, waitFor } from '@testing-library/react';

jest.mock('@/lib/prewarm', () => ({ prewarmOptimize: jest.fn() }));

import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip } from '@/lib/api';
import { prewarmOptimize } from '@/lib/prewarm';

/**
 * The chat's home-flight pre-search (prototype, exp/optimizer-speed): once
 * the planner knows the cities, home, dates, nights and party, it asks the
 * backend to search the home flights the plan will need — with exactly the
 * trip the plan then sends, so the backend's cache serves the plan.
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedPrewarm = prewarmOptimize as jest.MockedFunction<typeof prewarmOptimize>;

const staged = {
  destinations: ['Paris', 'Amsterdam', 'Berlin'],
  dateRange: { start: '2027-01-12', end: '2027-01-19' },
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK', 'EWR', 'LGA'],
  returnToHome: true,
  planningMode: 'destination' as const,
};

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  mockedOptimize.mockReturnValue(new Promise(() => {}) as any);
});

afterEach(() => window.history.pushState({}, '', '/'));

function startAutorun(answers: Record<string, unknown>) {
  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem('bluemurr-autorun', JSON.stringify(answers));
  return render(<PlanningChat />);
}

it('sends the trip the plan sends, once', async () => {
  startAutorun(staged);
  await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mockedPrewarm).toHaveBeenCalled());

  const { progressId: _p, budget: _b, ...planned } = mockedOptimize.mock.calls[0][0] as any;
  expect(mockedPrewarm).toHaveBeenCalledTimes(1);
  expect(mockedPrewarm.mock.calls[0][0]).toEqual(planned);
  expect(planned).toMatchObject({ travelers: 2, origin: 'New York', originAirports: ['JFK', 'EWR', 'LGA'], totalNights: 7 });
});

it('waits for the party size', async () => {
  const { travelers: _t, ...noParty } = staged;
  startAutorun(noParty);
  await new Promise((r) => setTimeout(r, 100));
  expect(mockedPrewarm).not.toHaveBeenCalled();
});
