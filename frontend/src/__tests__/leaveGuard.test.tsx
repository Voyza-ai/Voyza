import { mockPush, mockReplace, mockSearchParams } from './mocks';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';
import { buildTrip } from './fixtures';
import type { Trip } from '@/lib/types';

/**
 * "Leave without saving?" (lib/leaveGuard).
 *
 * A friend swiping two fingers on a Mac trackpad sent the browser Back from
 * /results to /plan, whose mount wipes the store: the trip they were working
 * on was gone, with no warning (the app router moves pages without unloading,
 * so `beforeunload` never fired).
 *
 * `routerPop` below stands in for the app router's own popstate listener:
 * if it hears a Back, the router renders the other page (synchronously, for
 * a page it has cached). It is added before any page mounts, as the router's
 * is (at hydration), and as a capture listener, so that jsdom calls it in the
 * order Chrome does — Chrome runs a window's popstate listeners in the order
 * they were added, capture or not. A guard that only added its listener when
 * the page mounted ran after the router: measured live, the planner was gone.
 */

// Signed in by default; the Google test signs out. (The shared mock's auth
// store is fixed to a signed-in user.)
const signedIn = { id: 'u1', email: 'test@test.com', user_metadata: {} };
const authStore = create<any>((set) => ({
  user: signedIn,
  session: { access_token: 'tok' },
  isLoading: false,
  avatarUrl: null,
  setUser: (user: any) => set({ user }),
  setSession: (session: any) => set({ session }),
  setAvatarUrl: (avatarUrl: any) => set({ avatarUrl }),
  signOut: jest.fn(),
}));
jest.doMock('@/store/authStore', () => ({
  useAuthStore: Object.assign((selector: any) => authStore(selector), { getState: () => authStore.getState() }),
}));
const mockSignInWithOAuth = jest.fn().mockResolvedValue({ data: {}, error: null });
jest.doMock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args: any[]) => mockSignInWithOAuth(...args),
      signInWithPassword: jest.fn(),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
    channel: jest.fn().mockReturnValue({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(), unsubscribe: jest.fn() }),
    removeChannel: jest.fn(),
  },
  getCurrentUser: jest.fn().mockResolvedValue(null),
  getAuthHeader: jest.fn().mockResolvedValue({}),
}));

const ResultsPage = require('@/app/results/page').default;
const PlanningChat = require('@/components/planning/PlanningChat').default;
const LeaveGuardModal = require('@/components/shared/LeaveGuardModal').default;
const { useTripStore } = require('@/store/tripStore');
const { useLeaveGuardStore } = require('@/lib/leaveGuard');
const { readCanvasIntent } = require('@/lib/canvasHandoff');
const api = jest.requireMock('@/lib/api');

const routerPop = jest.fn();

/** Let jsdom's queued history traversals (and what they set off) run. */
const tick = () => act(async () => {
  await new Promise((r) => setTimeout(r, 25));
});
async function back() {
  window.history.back();
  await tick();
  await tick();
}
async function forward() {
  window.history.forward();
  await tick();
  await tick();
}
/** What a tab close / reload / typed address would meet: true = the browser asks. */
function browserAsks(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}
const dialog = () => screen.queryByRole('alertdialog');

/** A trip the planner just handed over: never saved, on a bare /results. */
const unsavedTrip = (): Trip => ({ ...buildTrip(), id: undefined as any });
const editLeg = (t: Trip, departTime: string): Trip => {
  const cities = [...t.cities];
  cities[0] = { ...cities[0], transportOut: { ...cities[0].transportOut, departTime } };
  return { ...t, cities };
};

function openResults(trip: Trip, from = '/plan', at = '/results') {
  window.history.pushState({}, '', from);
  window.history.pushState({}, '', at);
  useTripStore.setState({ currentTrip: trip });
  return render(
    <>
      <ResultsPage />
      <LeaveGuardModal />
    </>,
  );
}

beforeAll(() => {
  window.addEventListener('popstate', routerPop, true);
  Element.prototype.scrollTo = jest.fn();
});
afterAll(() => window.removeEventListener('popstate', routerPop, true));

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  authStore.setState({ user: signedIn, session: { access_token: 'tok' } });
  useTripStore.setState({ currentTrip: null, answers: {}, chatHistory: [], tripPicks: null });
  useLeaveGuardStore.setState({ prompt: null, save: null });
  mockSearchParams.delete('tripId');
  // A fresh page: one an earlier test sent off to Google is back.
  window.dispatchEvent(new Event('pageshow'));
});

describe('results: a trip never saved', () => {
  it('Back asks first — Stay keeps the trip and the history, Leave goes back', async () => {
    openResults(unsavedTrip());
    const entries = window.history.length;

    await back();
    // The dialog, over the trip; the router never heard the Back and the
    // address is /results again.
    expect(dialog()).toHaveTextContent('Leave this trip?');
    expect(dialog()).toHaveTextContent("You haven't saved it yet, so it will be lost.");
    expect(routerPop).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/results');
    expect(screen.getByRole('button', { name: 'Stay' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe('/results');
    expect(window.history.length).toBe(entries);
    expect(useTripStore.getState().currentTrip?.title).toBe('Rome · Florence');
    expect(screen.getByText('Rome · Florence')).toBeInTheDocument();

    // Escape is Stay.
    await back();
    expect(dialog()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe('/results');
    expect(routerPop).not.toHaveBeenCalled();

    // Leave: the same Back, for real.
    await back();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await tick();
    expect(routerPop).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/plan');
    expect(dialog()).toBeNull();
  });

  it('the navbar logo asks first, and Leave follows it', async () => {
    openResults(unsavedTrip());
    const logo = screen.getByRole('link', { name: 'BlueMurr' });

    fireEvent.click(logo);
    expect(dialog()).toHaveTextContent('Leave this trip?');
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(logo);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(mockPush).toHaveBeenCalledWith('/main');
  });

  it('Save trip saves it here (no share dialog), and then nothing asks', async () => {
    openResults(unsavedTrip());
    expect(browserAsks()).toBe(true);

    await back();
    fireEvent.click(screen.getByRole('button', { name: 'Save trip' }));
    expect(dialog()).toBeNull();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/results?tripId=trip-123'));
    expect(api.saveTrip).toHaveBeenCalledTimes(1);
    expect(useTripStore.getState().currentTrip?.id).toBe('trip-123');
    expect(window.location.pathname).toBe('/results');
    expect(screen.queryByText(/Share this trip/i)).toBeNull();

    // Saved: Back and a close go through.
    expect(browserAsks()).toBe(false);
    await back();
    expect(dialog()).toBeNull();
    expect(routerPop).toHaveBeenCalledTimes(1);
  });

  it('the browser asks before a close or reload only while there is unsaved work', async () => {
    const view = openResults(unsavedTrip());
    expect(browserAsks()).toBe(true);
    // A keyboard reload brings the trip back from the tab's snapshot: not asked.
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    expect(browserAsks()).toBe(false);
    view.unmount();
    expect(browserAsks()).toBe(false);

    // A saved trip, fully saved: never asked.
    openResults(buildTrip());
    expect(browserAsks()).toBe(false);
  });
});

describe('results: a saved trip', () => {
  beforeEach(() => {
    api.getCanvasSession.mockResolvedValue({ session: { state: { trip: { title: 'Rome · Florence' } } }, role: 'owner' });
  });
  afterEach(() => {
    api.getCanvasSession.mockResolvedValue({ session: { state: null }, role: 'viewer' });
  });

  it('no dialog: a change is written on the way out, and only a close asks while it is being written', async () => {
    mockSearchParams.set('tripId', 'trip-test-123');
    const view = openResults(buildTrip(), '/history', '/results?tripId=trip-test-123');
    await screen.findByTestId('share-button'); // the owner's role is in

    // Fully saved: Back goes straight through.
    expect(browserAsks()).toBe(false);
    await back();
    expect(dialog()).toBeNull();
    expect(routerPop).toHaveBeenCalledTimes(1);
    await forward();

    // A change: a close now would cut its write off, so the browser asks…
    act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!, '13:14') }));
    expect(browserAsks()).toBe(true);
    // …until it is written.
    await waitFor(() => expect(api.saveCanvas).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await waitFor(() => expect(browserAsks()).toBe(false));

    // Another change, then straight Back: no dialog, and the change is
    // written as the page goes (it used to be dropped).
    act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!, '15:45') }));
    routerPop.mockClear();
    await back();
    expect(dialog()).toBeNull();
    expect(routerPop).toHaveBeenCalledTimes(1);
    view.unmount(); // the router renders /history
    await waitFor(() => expect(api.saveCanvas).toHaveBeenCalledTimes(2));
    expect(api.saveCanvas.mock.calls[1][1].cities[0].transportOut.departTime).toBe('15:45');
  });

  it('a trip opened read-only never asks', async () => {
    api.getCanvasSession.mockResolvedValue({ session: { state: null }, role: 'viewer' });
    api.getCanvasRole.mockResolvedValue({ role: 'viewer' });
    mockSearchParams.set('tripId', 'trip-test-123');
    openResults(buildTrip(), '/history', '/results?tripId=trip-test-123');
    await screen.findByText('View only');
    // The owner's edit arriving live changes the trip on this screen.
    act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!, '09:05') }));
    expect(browserAsks()).toBe(false);
    await back();
    expect(dialog()).toBeNull();
    expect(routerPop).toHaveBeenCalledTimes(1);
  });
});

describe('Google sign-in from the dialog', () => {
  it("Save trip signed out opens the sign-in prompt, and Google's redirect is not stopped", async () => {
    authStore.setState({ user: null, session: null });
    openResults(unsavedTrip());
    expect(browserAsks()).toBe(true);

    await back();
    fireEvent.click(screen.getByRole('button', { name: 'Save trip' }));
    expect(screen.getByText('Sign in to save your trip')).toBeInTheDocument();
    // The trip goes along to be saved after sign-in — to the trip, not Share.
    expect(readCanvasIntent()).toMatchObject({ destination: 'results', openShare: false, savedId: null });
    expect(readCanvasIntent().payload.cities).toHaveLength(2);

    fireEvent.click(screen.getByText('Continue with Google'));
    await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1));
    // The browser is on its way to Google: no "Leave site?".
    expect(browserAsks()).toBe(false);
  });
});

describe('the planner', () => {
  // A traveller's answers so far (as plannerGuidedResume.test.tsx).
  const answers = {
    destinations: ['Paris'],
    nights: 3,
    origin: 'New York',
    originAirports: ['JFK'],
    returnToHome: true,
    vibe: 'Culture',
    dateRange: { start: '2027-01-10', end: '2027-01-13' },
    travelers: 6,
    budget: 9000,
    budgetPerPerson: false,
    extraNotes: '',
  };

  function openPlanner() {
    window.history.pushState({}, '', '/main');
    window.history.pushState({}, '', '/plan');
    return render(
      <>
        <PlanningChat />
        <LeaveGuardModal />
      </>,
    );
  }
  async function answerDestination() {
    const bar = await screen.findByPlaceholderText('Type a destination...');
    fireEvent.change(bar, { target: { value: 'Paris' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await waitFor(() => expect(useTripStore.getState().answers.destinations).toEqual(['Paris']));
  }

  it('asks once one answer is given', async () => {
    openPlanner();
    fireEvent.click(await screen.findByText('I know where I want to go'));

    // Only the kind of trip picked: nothing to lose yet.
    expect(browserAsks()).toBe(false);
    await back();
    expect(dialog()).toBeNull();
    expect(routerPop).toHaveBeenCalledTimes(1);
    await forward();
    routerPop.mockClear();

    await answerDestination();
    expect(browserAsks()).toBe(true);
    await back();
    expect(dialog()).toHaveTextContent('Leave the planner?');
    expect(dialog()).toHaveTextContent("You haven't found your trip yet, so your answers will be lost.");
    expect(screen.queryByRole('button', { name: 'Save trip' })).toBeNull();
    expect(routerPop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(window.location.pathname).toBe('/plan');
    expect(useTripStore.getState().answers.destinations).toEqual(['Paris']);

    // The logo too.
    fireEvent.click(screen.getByRole('link', { name: 'BlueMurr' }));
    expect(dialog()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(mockPush).toHaveBeenCalledWith('/main');
  }, 15_000);

  it('Find my trip and the hand-over to /results are not stopped', async () => {
    let finish!: (v: any) => void;
    api.optimizeTrip.mockReturnValue(new Promise((r) => (finish = r)));
    openPlanner();
    useTripStore.setState({ answers: { ...answers } });
    fireEvent.click(await screen.findByText('I know where I want to go'));
    await answerDestination();
    await screen.findByText("Perfect — I've got everything I need. Ready to find your trip?", undefined, {
      timeout: 3000,
    });
    expect(browserAsks()).toBe(true);

    fireEvent.click(screen.getByText('Find my trip'));
    await waitFor(() => expect(api.optimizeTrip).toHaveBeenCalledTimes(1));
    // Searching: not asked.
    expect(browserAsks()).toBe(false);

    await act(async () => {
      finish({
        routes: [],
        bestRoute: { ordering: ['Paris'], totalCost: 0, legs: [] },
        savingsVsNaive: 0,
        iataCodes: {},
        dates: { Paris: { arrival: '2027-01-10', departure: '2027-01-13' } },
      });
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
    // Handed over: the planner, still on screen while /results loads, asks nothing.
    expect(dialog()).toBeNull();
    expect(browserAsks()).toBe(false);
    await back();
    expect(dialog()).toBeNull();
    expect(routerPop).toHaveBeenCalledTimes(1);
  }, 15_000);
});
