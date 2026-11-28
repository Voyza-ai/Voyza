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
import { useSavedTripAutosave, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, savedTripSignature } from '@/lib/useSavedTripAutosave';
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
  (getCanvasSession as jest.Mock).mockResolvedValue({ session: { state: { trip: { title: 'My Italy', constraints: { pins: ['x'] } } } }, role: 'owner' });
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
  // The saved session is built on, not replaced…
  expect(state.trip.constraints).toEqual({ pins: ['x'] });
  // …but the name is the trip's own (the session's copy goes stale).
  expect(state.trip.title).toBe(useTripStore.getState().currentTrip!.title);
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

it('a trip that keeps changing is still written within the max wait', async () => {
  // Found live: a collaborator's new city filled in (hotels, picks, legs) for
  // ~25s, each change restarting the debounce, and the owner's reload lost it.
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  let n = 0;
  for (let elapsed = 0; elapsed < AUTOSAVE_MAX_WAIT_MS + 800; elapsed += 400) {
    act(() => {
      const t = useTripStore.getState().currentTrip!;
      useTripStore.setState({ currentTrip: { ...t, travelers: 3 + (n++ % 5) } });
      jest.advanceTimersByTime(400);
    });
  }
  // Still changing — no quiet 700ms ever came — yet the write is due.
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(saveCanvas).toHaveBeenCalled();
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

it('never runs two saves at once: a change made mid-save is written after it, once', async () => {
  // Measured live: three saves landing together failed on the trip rows' foreign keys.
  let release!: () => void;
  (saveCanvas as jest.Mock).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  await flush();
  expect(saveCanvas).toHaveBeenCalledTimes(1); // first save, still running
  for (const n of [3, 4]) {
    act(() => {
      const t = useTripStore.getState().currentTrip!;
      useTripStore.setState({ currentTrip: { ...t, travelers: n } });
    });
    await flush();
  }
  expect(saveCanvas).toHaveBeenCalledTimes(1); // nothing overlapped it
  await act(async () => {
    release();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
  expect(saveCanvas).toHaveBeenCalledTimes(2); // one follow-up, from the latest trip
  expect((saveCanvas as jest.Mock).mock.calls[1][1].trip.travelers).toBe(4);
});

it("saves the name with the trip, and the saving and date tip by PATCH (the canvas save writes neither)", async () => {
  const { updateTrip } = jest.requireMock('@/lib/api');
  useTripStore.setState({
    currentTrip: { ...saved(), title: 'Rome → Florence', savings: 225, dateShiftSuggestion: { dayOffset: 1, newStartDate: '2026-06-16', newTotalCost: 1, savings: 50 } },
  });
  render(<Host />);
  act(() => {
    const t = useTripStore.getState().currentTrip!;
    useTripStore.setState({ currentTrip: { ...editLeg(t), title: 'Rome → Venice', savings: 0, dateShiftSuggestion: undefined } });
  });
  await flush();
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
  expect(saveCanvas).toHaveBeenCalledTimes(1);
  expect((saveCanvas as jest.Mock).mock.calls[0][1].trip.title).toBe('Rome → Venice');
  expect(updateTrip).toHaveBeenCalledWith('trip-saved-1', {
    savingsVsAlternative: 0,
    dateShiftSuggestion: null,
  });
});

it("a save after Blue's texted change doesn't carry Blue's mark on (so other tabs don't re-apply it)", async () => {
  (getCanvasSession as jest.Mock).mockResolvedValue({
    session: { state: { savedVia: 'text', textSaveId: 'abc', layout: { zoom: 2 }, trip: { title: 'My Italy' } } },
    role: 'owner',
  });
  useTripStore.setState({ currentTrip: saved() });
  render(<Host />);
  act(() => useTripStore.setState({ currentTrip: editLeg(useTripStore.getState().currentTrip!) }));
  await flush();
  expect(saveCanvas).toHaveBeenCalledTimes(1);
  const state = (saveCanvas as jest.Mock).mock.calls[0][1];
  expect(state.savedVia).toBeUndefined();
  expect(state.textSaveId).toBeUndefined();
  expect(state.layout).toEqual({ zoom: 2 }); // everything else in the session kept
});
