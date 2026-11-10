'use client';

import { useEffect, useRef } from 'react';
import { useTripStore } from '@/store/tripStore';
import { useAuthStore } from '@/store/authStore';
import { persistSavedTrip } from './canvasHandoff';
import type { Trip } from './types';

/** How long the trip has to stay still before a change is written. */
export const AUTOSAVE_DEBOUNCE_MS = 700;

/**
 * What the database keeps of a trip that the results page can change: the
 * cities (order, dates, the chosen hotel, picks), every leg the traveller can
 * swap, the flights home and the day schedules. Prices that the page
 * re-derives (totals) and hotel lists (re-ranked on every load) are left out,
 * so merely opening a trip doesn't count as a change.
 */
export function savedTripSignature(trip: Trip): string {
  const leg = (t: any) =>
    t ? [t.mode, t.operator, t.departTime, t.arriveTime, t.price, !!t.unavailable] : null;
  const home = (l: any) => (l ? [l.departDate, l.departTime, l.arriveTime, l.price, l.originAirport, l.destAirport] : null);
  return JSON.stringify([
    trip.travelers,
    trip.cities.map((c) => [
      c.name,
      c.dates.arrival,
      c.dates.departure,
      c.selectedHotelIndex,
      c.customHotel ?? null,
      c.activities,
      c.restaurants.map((r) => r.name),
      leg(c.transportIn),
      leg(c.transportOut),
      c.schedule ?? null,
    ]),
    home(trip.origin?.outboundLeg),
    home(trip.origin?.returnLeg),
  ]);
}

/**
 * Keeps a SAVED trip's database copy in step with what the results page
 * changes: a leg picked on the flowchart, an event moved in the day planner,
 * a city added from the AI chat. Before this, those changes lived only in the
 * tab — the database caught up only when the trip was next saved from Canvas,
 * so a reload of /results?tripId=… undid them.
 *
 * The first state seen for a trip is its baseline (what was just loaded); a
 * later change is written AUTOSAVE_DEBOUNCE_MS after the trip stops changing,
 * through the canvas save endpoint (owner only — see persistSavedTrip). A new
 * city's picks landing is a change of its own, so they are written too.
 *
 * Nothing is written while the tab is hidden: the trip may be open in Canvas
 * in another tab, and a background tab writing its older copy would undo the
 * edits made there.
 */
export function useSavedTripAutosave(): void {
  const trip = useTripStore((s) => s.currentTrip);
  const signedIn = useAuthStore((s) => !!s.user);
  const baseline = useRef<{ id: string; sig: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    const id = trip?.id;
    if (!trip || !id || id.startsWith('mock') || !signedIn) {
      baseline.current = null;
      return;
    }
    const sig = savedTripSignature(trip);
    if (!baseline.current || baseline.current.id !== id) {
      baseline.current = { id, sig };
      return;
    }
    if (sig === baseline.current.sig) return;
    baseline.current = { id, sig };
    if (timer.current) clearTimeout(timer.current);
    const save = () => {
      timer.current = null;
      pending.current = null;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const latest = useTripStore.getState().currentTrip;
      if (latest?.id !== id) return;
      persistSavedTrip(latest).catch(() => {});
    };
    pending.current = save;
    timer.current = setTimeout(save, AUTOSAVE_DEBOUNCE_MS);
  }, [trip, signedIn]);

  // Leaving the page (reload, closing the tab) with a write still waiting:
  // start it now rather than drop it.
  useEffect(() => {
    const flush = () => {
      if (!pending.current) return;
      if (timer.current) clearTimeout(timer.current);
      pending.current();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
}
