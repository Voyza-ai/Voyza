import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import ResultsPage from '@/app/results/page';
import { useTripStore } from '@/store/tripStore';
import { getCanvasSession, getCanvasSuggestions, getCanvasRole } from '@/lib/api';
import { buildCity, buildTrip } from './fixtures';

/**
 * The shared trip's role poll (the canvas's, now on the results page) must
 * not run in a tab nobody is looking at.
 *
 * Each canvas tab asked /api/canvas/:id/role every 25 s, hidden or not. That
 * is 36 requests per tab per 15 minutes against the general 100-request
 * limit: two forgotten canvas tabs spent 72 of it, and the planner in a third
 * tab then hit 429s the frontend swallows. A hidden tab now skips the poll,
 * and becoming visible re-checks at once.
 */

const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;
const mockedGetRole = getCanvasRole as jest.MockedFunction<typeof getCanvasRole>;

let hidden = false;
const setHidden = (value: boolean) => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeAll(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
});

afterAll(() => {
  delete (document as any).hidden;
  delete (document as any).visibilityState;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  hidden = false;
  mockedGetRole.mockResolvedValue({ role: 'owner' } as any);
  mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
  mockedGetSession.mockResolvedValue({
    session: { state: { trip: { title: 'Italy' }, cities: [buildCity({ name: 'Rome' }), buildCity({ name: 'Florence' })] } },
    role: 'owner',
  } as any);
});

const realFetch = global.fetch;
afterEach(() => {
  jest.useRealTimers();
  mockSearchParams.delete('tripId');
  global.fetch = realFetch;
});

async function openCanvas() {
  useTripStore.setState({ currentTrip: null });
  mockSearchParams.set('tripId', 'trip-italy');
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      trip: buildTrip({ id: 'trip-italy', title: 'Roman Holiday', cities: [buildCity({ name: 'Rome' }), buildCity({ name: 'Florence' })] }),
    }),
  }) as any;
  render(<ResultsPage />);
  expect(await screen.findByText('Roman Holiday')).toBeInTheDocument();
  // The session load has settled (it reads the role too).
  await act(async () => {
    await Promise.resolve();
  });
  mockedGetRole.mockClear();
}

const wait = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });

describe('shared trip role poll', () => {
  it('polls every 25 s while the tab is visible, as before', async () => {
    await openCanvas();
    await wait(25_000);
    expect(mockedGetRole).toHaveBeenCalledTimes(1);
    await wait(50_000);
    expect(mockedGetRole).toHaveBeenCalledTimes(3);
  });

  it('makes no requests while hidden, checks once on return, then resumes', async () => {
    await openCanvas();
    await act(async () => setHidden(true));
    mockedGetRole.mockClear();

    await wait(15 * 60_000); // a forgotten tab, a whole rate-limit window
    expect(mockedGetRole).not.toHaveBeenCalled();

    await act(async () => setHidden(false));
    expect(mockedGetRole).toHaveBeenCalledTimes(1); // the return-to-tab check

    await wait(25_000);
    expect(mockedGetRole).toHaveBeenCalledTimes(2); // and the poll is back
  });
});
