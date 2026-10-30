import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import BrowsePage from '@/app/browse/page';
import { useTripStore } from '@/store/tripStore';
import { ApiError, getPresetCatalog, optimizeTrip } from '@/lib/api';
import { PRESET_ITINERARIES } from '@/data/presetItineraries';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;

/**
 * Planner copy that said something false (D-11/E14, D-19):
 *  - "Plan a similar trip" announced "…with the shifted dates…" though no
 *    date was shifted;
 *  - a 400 the server explained ("Each city can appear only once") came out
 *    as "Try rephrasing the dates or budget?", and only a request that never
 *    got an answer may say "Check your connection";
 *  - a typed range was echoed back as its start date, "2027-01-10".
 */

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});
beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  mockedOptimize.mockReturnValue(new Promise(() => {}) as any); // in flight
});
afterEach(() => {
  window.history.pushState({}, '', '/');
  sessionStorage.clear();
});

const staged = {
  destinations: ['Paris'],
  dateRange: { start: '2026-11-29', end: '2026-12-02' },
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  planningMode: 'destination',
};

describe('the autorun status line', () => {
  it('"Plan a similar trip" stages why it is running', async () => {
    mockSearchParams.delete('preset');
    (getPresetCatalog as jest.Mock).mockResolvedValue({ presets: [], editorial: { staffPicks: [], trending: [] }, categories: [] });
    const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;
    render(<BrowsePage />);
    fireEvent.click(screen.getByText(paris.title));
    fireEvent.click(screen.getByRole('switch', { name: 'Use my location' })); // no prompt in jsdom
    fireEvent.click(screen.getByRole('button', { name: /Plan a similar trip/ }));
    await waitFor(() => expect(sessionStorage.getItem('bluemurr-autorun')).not.toBeNull());
    expect(JSON.parse(sessionStorage.getItem('bluemurr-autorun')!).autorunReason).toBe('similar-trip');
  });

  it('a similar trip says what it is doing, not "shifted dates"', async () => {
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify({ ...staged, autorunReason: 'similar-trip' }));
    render(<PlanningChat />);
    expect(
      await screen.findByText(
        'Planning your trip starting Nov 29, 2026 — searching flights, trains, and hotels at today’s prices...',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/shifted dates/)).not.toBeInTheDocument();
    // The reason is not a planner answer.
    expect((useTripStore.getState().answers as any).autorunReason).toBeUndefined();
  });

  it('a real date shift (Cheaper start dates) still says so', async () => {
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
    render(<PlanningChat />);
    expect(
      await screen.findByText(
        'Recalculating your trip starting Nov 29, 2026 — searching flights, trains, and hotels with the shifted dates...',
      ),
    ).toBeInTheDocument();
  });
});

describe('when the search fails', () => {
  const run = async (err: unknown) => {
    mockedOptimize.mockRejectedValue(err);
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify({ ...staged, destinations: ['Paris', 'Rome', 'Paris'] }));
    render(<PlanningChat />);
    return (await screen.findByText(/Sorry, I ran into a problem/)).textContent;
  };

  it('a 4xx shows the server’s own message', async () => {
    // What errorHandler sends for the repeated-city check (routes/index.ts).
    const text = await run(new ApiError(400, 'ValidationError', { cities: ['Each city can appear only once'] }));
    expect(text).toBe('Sorry, I ran into a problem: Each city can appear only once.');
  });

  it('a 4xx with a plain error message shows that message', async () => {
    const text = await run(new ApiError(429, 'Too many requests — please try again in a few minutes.'));
    expect(text).toBe('Sorry, I ran into a problem: Too many requests — please try again in a few minutes.');
  });

  it('a request that never got an answer keeps the connection wording', async () => {
    const text = await run(new TypeError('Failed to fetch'));
    expect(text).toBe("Sorry, I ran into a problem: I couldn't reach the travel service. Check your connection and try again.");
  });
});

describe('typed dates are echoed back whole, in words', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'queueMicrotask', 'nextTick', 'setImmediate'] }).setSystemTime(new Date(2026, 9, 30, 12));
    useTripStore.setState({
      answers: { origin: 'New York', originAirports: ['JFK'], returnToHome: true, vibe: 'Culture' },
      chatHistory: [],
      currentTrip: null,
    });
  });
  afterEach(() => jest.useRealTimers());

  async function typeDates(value: string) {
    window.history.pushState({}, '', '/plan?resume=1');
    render(<PlanningChat />);
    fireEvent.click(await screen.findByText('I know where I want to go'));
    const bar = await screen.findByPlaceholderText('Type a destination...');
    fireEvent.change(bar, { target: { value: 'Paris' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await screen.findByText('When are you thinking?', undefined, { timeout: 3000 });
    const dates = screen.getByPlaceholderText(/Or type when/);
    fireEvent.change(dates, { target: { value } });
    fireEvent.keyDown(dates, { key: 'Enter' });
  }

  it('a range: both ends', async () => {
    await typeDates('Jan 10 to Jan 17, 2027');
    expect(await screen.findByText('Jan 10 – Jan 17, 2027')).toBeInTheDocument();
    expect(screen.queryByText('2027-01-10')).not.toBeInTheDocument();
  });

  it('a range across New Year: each end with its year', async () => {
    await typeDates('Dec 28 to Jan 4, 2027');
    expect(await screen.findByText('Dec 28, 2026 – Jan 4, 2027')).toBeInTheDocument();
  });

  it('a single date: the date it was read as', async () => {
    await typeDates('2027-01-10');
    expect(await screen.findByText('Jan 10, 2027')).toBeInTheDocument();
  });
});
