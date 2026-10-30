import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip } from '@/lib/api';

/**
 * "Adjust trip" after the GUIDED planner.
 *
 * The results page's button goes to /plan?resume=1 with the tooltip "Reopen
 * the planning chat with your trip loaded — change anything and search
 * again". The resume path only knew the AI chat: it rejoins a conversation
 * from `chatHistory` in the store. The guided planner keeps its conversation
 * in component state, which dies when the planner unmounts on the way to
 * /results — so a guided traveller came back to a blank "What kind of trip
 * are you planning?" (agent D, run r1), their answers still in the store but
 * nothing on screen to show or change them.
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;

const answers = {
  destinations: ['Paris'],
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  vibe: 'Culture',
  dateRange: { start: '2027-01-10', end: '2027-01-13' },
  nights: 3,
  travelers: 6,
  budget: 9000,
  budgetPerPerson: false,
  extraNotes: '',
};

const optimizeResult = {
  routes: [],
  bestRoute: { ordering: ['Paris'], totalCost: 0, legs: [] },
  savingsVsNaive: 0,
  iataCodes: {},
  dates: { Paris: { arrival: '2027-01-10', departure: '2027-01-13' } },
} as any;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  mockedOptimize.mockResolvedValue(optimizeResult);
});

afterEach(() => window.history.pushState({}, '', '/'));

/**
 * A real guided session up to /results: pick "I know where I want to go",
 * type the destination, everything else already answered, Find my trip.
 * Starts from a fresh /plan visit, so it also clears whatever an earlier
 * test left behind.
 */
async function guidedSessionToResults() {
  window.history.pushState({}, '', '/plan');
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  const first = render(<PlanningChat />);
  // The fresh visit has reset the store; this traveller's answers so far.
  useTripStore.setState({ answers: { ...answers } });
  fireEvent.click(await screen.findByText('I know where I want to go'));
  const bar = await screen.findByPlaceholderText('Type a destination...');
  fireEvent.change(bar, { target: { value: 'Paris' } });
  fireEvent.keyDown(bar, { key: 'Enter' });
  await screen.findByText("Perfect — I've got everything I need. Ready to find your trip?", undefined, {
    timeout: 3000,
  });
  fireEvent.click(screen.getByText('Find my trip'));
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
  first.unmount(); // on to /results
  mockPush.mockClear();
  mockedOptimize.mockClear();
}

it('comes back to the guided conversation, ready to search again', async () => {
  await guidedSessionToResults();

  window.history.pushState({}, '', '/plan?resume=1'); // "Adjust trip"
  render(<PlanningChat />);

  // The traveller's own answers are on screen, with the search button.
  expect(await screen.findByText('I have a place in mind')).toBeInTheDocument();
  expect(screen.getByText('Paris')).toBeInTheDocument();
  expect(screen.getByText("Perfect — I've got everything I need. Ready to find your trip?")).toBeInTheDocument();
  const findMyTrip = await screen.findByText('Find my trip');
  // Not the blank picker.
  expect(screen.queryByText('I know where I want to go')).toBeNull();

  // And "search again" works from here, with the answers they gave.
  fireEvent.click(findMyTrip);
  await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));
  expect(mockedOptimize.mock.calls[0][0]).toMatchObject({ travelers: 6, startDate: '2027-01-10' });
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
}, 20_000);

it('a fresh visit after a guided session still starts clean', async () => {
  await guidedSessionToResults();

  window.history.pushState({}, '', '/plan');
  render(<PlanningChat />);

  expect(await screen.findByText('I know where I want to go')).toBeInTheDocument();
  expect(screen.queryByText('Find my trip')).toBeNull();
  expect(useTripStore.getState().answers.destinations).toBeUndefined();
}, 20_000);

it('a one-click date-shift replan after a guided session runs as before', async () => {
  await guidedSessionToResults();

  window.history.pushState({}, '', '/plan?resume=1&autorun=1');
  sessionStorage.setItem(
    'bluemurr-autorun',
    JSON.stringify({ ...answers, dateRange: { start: '2027-01-11', end: '2027-01-14' } }),
  );
  mockedOptimize.mockReturnValue(new Promise(() => {}) as any);
  render(<PlanningChat />);

  expect(await screen.findByText(/Recalculating your trip starting Jan 11, 2027/)).toBeInTheDocument();
  // The old transcript is not resurrected over the replan.
  expect(screen.queryByText('I have a place in mind')).toBeNull();
}, 20_000);

it('the AI-chat resume path is unchanged', async () => {
  window.history.pushState({}, '', '/plan');
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  render(<PlanningChat />).unmount(); // a fresh visit: nothing guided kept

  useTripStore.setState({
    answers: { ...answers },
    chatHistory: [
      { role: 'user', content: 'Paris for six in January' },
      { role: 'assistant', content: 'Lovely — anything else?' },
    ],
  });
  window.history.pushState({}, '', '/plan?resume=1');
  render(<PlanningChat />);

  expect(await screen.findByText('Paris for six in January')).toBeInTheDocument();
  expect(screen.queryByText('I know where I want to go')).toBeNull();
});
