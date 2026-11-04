// Google sign-in from Edit in Canvas while the AI picks are still loading.
// Standalone mocks (as oauthReturnTo.test.tsx): the real store, the real
// canvas handoff, the real callback page.

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
jest.mock('next/link', () => {
  const React = require('react');
  return { __esModule: true, default: ({ children, href, ...props }: any) => React.createElement('a', { href, ...props }, children) };
});
// Back from Google, signed in.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { access_token: 'tok', user: { id: 'u1', email: 'a@b.c' } } },
      }),
      exchangeCodeForSession: jest.fn(),
    },
  },
}));
jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => selector({ setUser: jest.fn(), setSession: jest.fn() }),
}));
jest.mock('@/lib/api', () => ({
  searchActivities: jest.fn(),
  searchRestaurants: jest.fn(),
  saveTrip: jest.fn().mockResolvedValue({ tripId: 'trip-9', trip: {} }),
  fetchHomeLegs: jest.fn(),
  resolvePlaces: jest.fn().mockResolvedValue({ provider: 'osm', places: [] }),
}));

import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import AuthCallbackPage from '@/app/auth/callback/page';
import { useTripStore, startTripPicks, type CityPicks } from '@/store/tripStore';
import { stashCanvasIntent } from '@/lib/canvasHandoff';
import { liveTripTotal } from '@/lib/tripTotals';
import { saveTrip, searchActivities, searchRestaurants } from '@/lib/api';
import type { Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

const mockedSave = saveTrip as jest.Mock;
const mockedActivities = searchActivities as jest.Mock;
const mockedRestaurants = searchRestaurants as jest.Mock;

const activity = (city: string) => ({ name: `${city} museum`, category: 'museum', timeOfDay: 'morning', durationHours: 2, reason: '' });
const restaurant = (city: string) => ({ name: `${city} bistro`, cuisine: 'French', priceRange: '$$', mealType: 'dinner', reason: '' });

function pageEvent(type: 'pagehide' | 'pageshow') {
  const ev = new Event(type);
  Object.defineProperty(ev, 'persisted', { value: false });
  window.dispatchEvent(ev);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** /results with picks still loading, then "Edit in Canvas" → "Continue with Google". */
async function leaveForGoogleMidLoad(): Promise<Trip> {
  jest.useFakeTimers();
  const t = buildTrip();
  const trip = {
    ...t,
    id: undefined,
    origin: undefined,
    cities: t.cities.map((c) => ({ ...c, activities: [], restaurants: [], schedule: {} })),
  } as Trip;
  const inFlight = trip.cities.map(() => deferred<CityPicks>());
  startTripPicks(
    trip,
    trip.cities.map((c) => ({ city: c.name, travelers: 2, nights: 2 })),
    inFlight.map((d) => d.promise),
  );
  const onScreen = useTripStore.getState().currentTrip!;
  // What ResultsHeader stashes before opening the sign-in modal.
  stashCanvasIntent({
    savedId: null,
    payload: { ...onScreen, totalCost: liveTripTotal(onScreen) },
    origin: null,
    syncCities: onScreen.cities,
  });
  // The redirect, in the order Chromium did it (measured): the requests still
  // out fail first, then `pagehide`. Then the page is gone, its timers too.
  await act(async () => {
    inFlight.forEach((d) => d.reject(new TypeError('Failed to fetch')));
  });
  pageEvent('pagehide');
  jest.clearAllTimers();
  jest.useRealTimers();
  // The page Google sends back to is a fresh one: an empty store, the same tab's storage.
  const saved = sessionStorage.getItem('bluemurr-current-trip')!;
  const intent = sessionStorage.getItem('voyza.pending_canvas')!;
  useTripStore.setState({ currentTrip: null, tripPicks: null, restoredFromSession: false });
  sessionStorage.setItem('bluemurr-current-trip', saved);
  sessionStorage.setItem('voyza.pending_canvas', intent);
  pageEvent('pageshow');
  return trip;
}

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  pageEvent('pageshow');
  useTripStore.setState({ currentTrip: null, tripPicks: null, restoredFromSession: false });
});

it('saves the canvas trip with the picks that were loading when the user left for Google', async () => {
  const trip = await leaveForGoogleMidLoad();
  mockedActivities.mockImplementation(async ({ city }: any) => [activity(city)]);
  mockedRestaurants.mockImplementation(async ({ city }: any) => [restaurant(city)]);

  await act(async () => {
    render(<AuthCallbackPage />);
  });

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/canvas/trip-9'));
  expect(mockedSave).toHaveBeenCalledTimes(1);
  const savedCities = mockedSave.mock.calls[0][0].cities;
  expect(savedCities.map((c: any) => c.activities)).toEqual(trip.cities.map((c) => [`${c.name} museum`]));
  expect(savedCities.map((c: any) => c.restaurants[0]?.name)).toEqual(trip.cities.map((c) => `${c.name} bistro`));
  // Asked again only for the cities that were waiting: all of them here.
  expect(mockedActivities.mock.calls.map((c) => c[0].city)).toEqual(trip.cities.map((c) => c.name));
});

it('a pick that fails again after the redirect: the canvas is still saved and opened, that city without picks', async () => {
  const trip = await leaveForGoogleMidLoad();
  mockedActivities.mockImplementation(async ({ city }: any) => {
    if (city === trip.cities[0].name) throw new Error('502');
    return [activity(city)];
  });
  mockedRestaurants.mockImplementation(async ({ city }: any) => {
    if (city === trip.cities[0].name) throw new Error('502');
    return [restaurant(city)];
  });

  await act(async () => {
    render(<AuthCallbackPage />);
  });

  // The failure is taken in after FAILED_PICKS_GRACE_MS on this page.
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/canvas/trip-9'), { timeout: 5000 });
  const savedCities = mockedSave.mock.calls[0][0].cities;
  expect(savedCities[0].activities).toEqual([]);
  expect(savedCities[1].activities).toEqual([`${trip.cities[1].name} museum`]);
});

it('an intent with no picks loading (a saved trip, or a Browse preset) is resumed as before, without waiting', async () => {
  stashCanvasIntent({ savedId: 'trip-1', payload: null, origin: null, syncCities: null });

  await act(async () => {
    render(<AuthCallbackPage />);
  });

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/canvas/trip-1'));
  expect(mockedSave).not.toHaveBeenCalled();
  expect(mockedActivities).not.toHaveBeenCalled();
});
