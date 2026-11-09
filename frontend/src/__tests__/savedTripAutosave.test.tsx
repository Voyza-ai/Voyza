/**
 * A saved trip's changes on the results page reach the database (found live:
 * a train picked on the flowchart of a saved trip, and a city added from the
 * AI chat, were both gone after a reload).
 */
import './mocks';
import React from 'react';
import { act, render } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { getCanvasSession, saveCanvas } from '@/lib/api';
import { useSavedTripAutosave, AUTOSAVE_DEBOUNCE_MS, savedTripSignature } from '@/lib/useSavedTripAutosave';
import { buildTrip } from './fixtures';
import type { Trip } from '@/lib/types';

function Host() {
  useSavedTripAutosave();
  return null;
}

const saved = (): Trip => ({ ...buildTrip(), id: 'trip-saved-1' });
const flush = async () => {
  await act(async () => {
    jest.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 10);
  });
  // persistSavedTrip awaits the session read before saving.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const editLeg = (t: Trip): Trip => {
  const cities = [...t.cities];
  cities[0] = { ...cities[0], transportOut: { ...cities[0].transportOut, departTime: '13:14' } };
  return { ...t, cities };
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (getCanvasSession as jest.Mock).mockResolvedValue({ session: { state: { trip: { title: 'My Italy' } } }, role: 'owner' });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  jest.useRealTimers();
  (getCanvasSession as jest.Mock).mockResolvedValue({ session: { state: null }, role: 'viewer' });
});

it('opening a saved trip writes nothing', async () => {
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  await flush();
  expect(saveCanvas).not.toHaveBeenCalled();
});

it('a leg picked on a saved trip is written once the trip stops changing', async () => {
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  expect(saveCanvas).not.toHaveBeenCalled(); // debounced
  await flush();
  expect(saveCanvas).toHaveBeenCalledTimes(1);
  const [id, state] = (saveCanvas as jest.Mock).mock.calls[0];
  expect(id).toBe('trip-saved-1');
  expect(state.cities[0].transportOut.departTime).toBe('13:14');
  expect(state.trip.title).toBe('My Italy'); // the saved session is built on, not replaced
});

it('several quick changes are one write', async () => {
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  act(() => {
    jest.advanceTimersByTime(500);
    const t = useTripStore.getState().currentTrip!;
    useTripStore.setState({ currentTrip: { ...t, travelers: 3 } });
  });
  await flush();
  expect(saveCanvas).toHaveBeenCalledTimes(1);
  expect((saveCanvas as jest.Mock).mock.calls[0][1].trip.travelers).toBe(3);
});

it('an unsaved trip, a non-owner and a hidden tab write nothing', async () => {
  // Unsaved
  useTripStore.setState({ currentTrip: { ...buildTrip(), id: undefined as any } });
  const { unmount } = render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  await flush();
  unmount();
  expect(saveCanvas).not.toHaveBeenCalled();
  // Not the owner
  (getCanvasSession as jest.Mock).mockResolvedValue({ session: { state: {} }, role: 'editor' });
  useTripStore.setState({ currentTrip: saved() });
  const third = render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  await flush();
  third.unmount();
  expect(saveCanvas).not.toHaveBeenCalled();
  // Hidden tab (the trip may be open in Canvas in another tab)
  (getCanvasSession as jest.Mock).mockResolvedValue({ session: { state: {} }, role: 'owner' });
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  await flush();
  expect(saveCanvas).not.toHaveBeenCalled();
});

it('the signature ignores hotel lists and totals but sees legs, schedules and cities', () => {
  const t = saved();
  const sig = savedTripSignature(t);
  expect(savedTripSignature({ ...t, totalCost: 99999 })).toBe(sig);
  expect(savedTripSignature({ ...t, cities: t.cities.map((c) => ({ ...c, hotels: [] })) })).toBe(sig);
  expect(savedTripSignature(editLeg(t))).not.toBe(sig);
  expect(savedTripSignature({ ...t, cities: [t.cities[1], t.cities[0]] })).not.toBe(sig);
  const withEvent = { ...t, cities: t.cities.map((c, i) => (i ? c : { ...c, schedule: { '2026-06-15': [{ id: 'x', title: 'Mine', startTime: '07:00', endTime: '08:00' }] } })) };
  expect(savedTripSignature(withEvent)).not.toBe(sig);
});
