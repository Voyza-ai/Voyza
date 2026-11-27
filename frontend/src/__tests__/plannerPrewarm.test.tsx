import './mocks';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';

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

/**
 * The follow-up flow (buildRemainingSteps) asks home, one-way/round-trip and
 * the party BEFORE dates, and the AI can fill in the party at the destination
 * step. The pre-search used to fire as soon as cities, home and party were
 * known — on a made-up start date — and again for every later answer.
 */
it('the follow-up flow\'s order: nothing until dates and the trip length are answered, then once', async () => {
  render(<PlanningChat />);
  const answer = async (patch: Record<string, unknown>) => {
    await act(async () => {
      useTripStore.setState((st: any) => ({ answers: { ...st.answers, ...patch } }));
    });
    await new Promise((r) => setTimeout(r, 20));
  };
  // The AI's read of "Paris, Amsterdam and Berlin with my partner".
  await answer({ destinations: ['Paris', 'Amsterdam', 'Berlin'], travelers: 2, planningMode: 'destination' });
  await answer({ origin: 'New York', originAirports: ['JFK', 'EWR', 'LGA'] });
  await answer({ returnToHome: true });
  expect(mockedPrewarm).not.toHaveBeenCalled();
  // "When are you thinking?" — a vague month: still no trip length.
  await answer({ dateRange: { start: 'next month', end: '' } });
  expect(mockedPrewarm).not.toHaveBeenCalled();
  // "How many nights total?"
  await answer({ nights: 7 });
  expect(mockedPrewarm).toHaveBeenCalledTimes(1);
  expect(mockedPrewarm.mock.calls[0][0]).toMatchObject({ travelers: 2, origin: 'New York', returnToHome: true, totalNights: 7 });
  // Budget and notes change nothing the flights depend on: no second set.
  await answer({ budget: 4000, extraNotes: 'no red-eyes' });
  expect(mockedPrewarm).toHaveBeenCalledTimes(1);
});

it('one-way or round-trip is an answer the pre-search waits for, not a default', async () => {
  const { returnToHome: _r, ...unanswered } = staged;
  render(<PlanningChat />);
  await act(async () => {
    useTripStore.setState({ answers: { ...unanswered } as any });
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(mockedPrewarm).not.toHaveBeenCalled();
});
