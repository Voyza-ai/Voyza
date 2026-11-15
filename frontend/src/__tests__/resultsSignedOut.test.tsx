import { mockPush, mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { create } from 'zustand';
import { buildCity } from './fixtures';

/**
 * Opening a shared trip's link signed out (audit D-16; the canvas page this
 * was written for is now the results page).
 *
 * The canvas session route needs a signed-in user (401 otherwise), but the
 * page loaded it anyway: the visitor got "Connection lost — reconnecting
 * automatically..." and a "Failed to load canvas session" toast, with no way
 * forward. It now shows the existing sign-in modal, loads nothing until
 * someone is signed in, and opens the canvas once they are.
 */

// A signed-out visitor, with an auth store that changes when they sign in
// (the shared mock is fixed to a signed-in user).
const authStore = create<any>((set) => ({
  user: null,
  session: null,
  isLoading: false,
  setUser: (user: any) => set({ user }),
  setSession: (session: any) => set({ session }),
  signOut: jest.fn(),
}));
jest.doMock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => authStore(selector),
}));
const mockSignIn = jest.fn();
jest.doMock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => mockSignIn(...args),
      signInWithOAuth: jest.fn(),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
    channel: jest.fn().mockReturnValue({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(), unsubscribe: jest.fn() }),
    removeChannel: jest.fn(),
  },
  getCurrentUser: jest.fn().mockResolvedValue(null),
  getAuthHeader: jest.fn().mockResolvedValue({}),
}));
// Realtime cannot connect for a visitor with no session.
jest.doMock('@/hooks/useCanvasRealtime', () => ({
  useCanvasRealtime: () => ({
    canvasState: null,
    suggestions: [],
    isConnected: false,
    presence: [],
    remoteOp: null,
    broadcastOp: jest.fn(),
    roleEvent: null,
    broadcastRoleChange: jest.fn(),
    cursorEvent: null,
    broadcastCursor: jest.fn(),
  }),
}));

const api = jest.requireMock('@/lib/api');
const ResultsPage = require('@/app/results/page').default;
const { useTripStore } = require('@/store/tripStore');
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  authStore.setState({ user: null, session: null, isLoading: false });
  api.getCanvasSession.mockResolvedValue({
    session: {
      state: {
        trip: { title: 'Owner trip', travelers: 6 },
        cities: [buildCity({ name: 'Paris', dates: { arrival: '2027-01-11', departure: '2027-01-13' } })],
      },
    },
    role: 'owner',
  });
  api.getCanvasSuggestions.mockResolvedValue({ suggestions: [] });
  useTripStore.setState({ currentTrip: null });
  mockSearchParams.set('tripId', 'trip-paris');
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      trip: {
        id: 'trip-paris',
        title: 'Owner trip',
        status: 'planning',
        totalCost: 0,
        savings: 0,
        travelers: 6,
        savingsTips: [],
        cities: [buildCity({ name: 'Paris', dates: { arrival: '2027-01-11', departure: '2027-01-13' } })],
      },
    }),
  }) as any;
});

afterEach(() => {
  mockSearchParams.delete('tripId');
  global.fetch = realFetch;
});

describe('a shared trip link opened signed out', () => {
  it('asks the visitor to sign in instead of failing to load', async () => {
    render(<ResultsPage />);
    expect(await screen.findByText('Sign in or create an account to open this trip')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    // Nothing was asked of a route that refuses anonymous callers…
    expect(api.getCanvasSession).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // …so nothing failed.
    expect(screen.queryByText('Failed to load canvas session')).not.toBeInTheDocument();
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();
  });

  it('opens the trip once they sign in', async () => {
    mockSignIn.mockResolvedValue({
      data: { session: { access_token: 'tok' }, user: { id: 'u1', email: 'owner@test.com', user_metadata: {} } },
      error: null,
    });
    render(<ResultsPage />);
    await screen.findByText('Sign in or create an account to open this trip');
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'owner@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText('Email').closest('form')!);
    });

    await waitFor(() => expect(api.getCanvasSession).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText('Paris')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Sign in or create an account to open this trip')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load canvas session')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('closing the sign-in without signing in leaves for the hub, not a dead page', async () => {
    render(<ResultsPage />);
    await screen.findByText('Sign in or create an account to open this trip');
    const close = screen.getByText('Sign in or create an account to open this trip').closest('div')!.parentElement!.querySelector('button')!;
    await act(async () => {
      fireEvent.click(close);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mockPush).toHaveBeenCalledWith('/main');
    expect(api.getCanvasSession).not.toHaveBeenCalled();
  });

  it('"Create account" goes to sign-up and comes back to this trip, not to the hub', async () => {
    // Found live: the popup closed first, and the page's "dismissed → /main" redirect won.
    window.history.replaceState({}, '', '/results?tripId=trip-1&share=tok');
    render(<ResultsPage />);
    await screen.findByText('Sign in or create an account to open this trip');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      `/auth/signup?next=${encodeURIComponent('/results?tripId=trip-1&share=tok')}`,
    );
    window.history.replaceState({}, '', '/');
  });
});
