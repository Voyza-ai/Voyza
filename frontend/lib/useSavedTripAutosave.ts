'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useTripStore } from '@/store/tripStore';
import { useAuthStore } from '@/store/authStore';
import { persistSavedTrip } from './canvasHandoff';
import { updateTrip } from './api';
import type { Trip } from './types';

/**
 * Whether the saved trip on screen has a change the database doesn't have
 * yet: waiting for its write, being written, or a write that failed or was
 * skipped (hidden tab). The results page asks before the tab is closed or
 * reloaded while it does (lib/leaveGuard) — that can cut the write off.
 */
export const useSavedTripUnsaved = create<{ unsaved: boolean }>(() => ({ unsaved: false }));
function setUnsaved(unsaved: boolean) {
  if (useSavedTripUnsaved.getState().unsaved !== unsaved) useSavedTripUnsaved.setState({ unsaved });
}

/** How long the trip has to stay still before a change is written. */
export const AUTOSAVE_DEBOUNCE_MS = 700;
/**
 * The longest a change waits while the trip keeps changing. A collaborator's
 * new city fills in for many seconds (hotels, picks, legs, each a change),
 * and a plain debounce kept restarting: measured, an editor's added city was
 * still unsaved ~25s later, so the owner's reload lost it.
 */
export const AUTOSAVE_MAX_WAIT_MS = 3000;

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
    tripMeta(trip),
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
 * Trip-row facts a change on this page can move that the canvas save does
 * not write: the saving "vs your original city order" and the date-shift
 * tip (both dropped when the stops are rearranged by hand). Saved with a
 * PATCH, or a reload brought the old ones back. (The name is in the title:
 * an auto-titled trip follows its stops; the save writes it.)
 */
type TripMeta = { title: string; savings: number; shift: boolean };
function tripMeta(trip: Trip): TripMeta {
  return { title: trip.title ?? '', savings: trip.savings ?? 0, shift: !!trip.dateShiftSuggestion };
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
  /** Fires AUTOSAVE_MAX_WAIT_MS after the oldest unsaved change. */
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  /** The trip-row facts as last saved (see tripMeta). */
  const savedMeta = useRef<{ id: string; meta: TripMeta } | null>(null);

  useEffect(() => {
    const id = trip?.id;
    if (!trip || !id || id.startsWith('mock') || !signedIn) {
      baseline.current = null;
      setUnsaved(false);
      return;
    }
    const sig = savedTripSignature(trip);
    if (!baseline.current || baseline.current.id !== id) {
      baseline.current = { id, sig };
      savedMeta.current = { id, meta: tripMeta(trip) };
      setUnsaved(false);
      return;
    }
    if (sig === baseline.current.sig) return;
    baseline.current = { id, sig };
    setUnsaved(true);
    if (timer.current) clearTimeout(timer.current);
    const save = () => {
      if (timer.current) clearTimeout(timer.current);
      if (maxTimer.current) clearTimeout(maxTimer.current);
      timer.current = null;
      maxTimer.current = null;
      pending.current = null;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // One save at a time. A save rewrites the trip's city and leg rows, and
      // two landing together (a busy backend answering the session reads
      // late) failed on the rows' foreign keys — measured: three 500s while
      // cities were being rearranged. A change made during a save is written
      // once that save finishes, from the trip as it is then.
      if (inFlight.current) {
        again.current = true;
        return;
      }
      // Whether the last write went through (or there was nothing this
      // person may write: persistSavedTrip is the owner's alone).
      let ok = true;
      const run = (): Promise<void> => {
        const latest = useTripStore.getState().currentTrip;
        if (latest?.id !== id) return Promise.resolve();
        ok = false;
        return persistSavedTrip(latest)
          .then((saved) => {
            ok = true;
            if (!saved) return;
            const now = tripMeta(latest);
            const was = savedMeta.current?.id === id ? savedMeta.current.meta : null;
            const patch: Record<string, unknown> = {};
            if (!was || now.savings !== was.savings) patch.savingsVsAlternative = now.savings;
            if (was && was.shift && !now.shift) patch.dateShiftSuggestion = null;
            if (Object.keys(patch).length === 0) return;
            return updateTrip(id, patch as any).then(() => {
              savedMeta.current = { id, meta: now };
            });
          })
          .catch(() => undefined)
          .then(() => {
            if (!again.current) return;
            again.current = false;
            return run();
          });
      };
      inFlight.current = run().finally(() => {
        inFlight.current = null;
        // Nothing newer waiting: the trip is as saved as it gets.
        if (!pending.current && baseline.current?.id === id) setUnsaved(!ok);
      });
    };
    pending.current = save;
    timer.current = setTimeout(save, AUTOSAVE_DEBOUNCE_MS);
    if (!maxTimer.current) {
      maxTimer.current = setTimeout(() => {
        maxTimer.current = null;
        pending.current?.();
      }, AUTOSAVE_MAX_WAIT_MS);
    }
  }, [trip, signedIn]);

  // Leaving the page with a write still waiting: start it now rather than
  // drop it. A reload or a closed tab can still cut it off (the page asks
  // first, see useSavedTripUnsaved); leaving within the app can't — the
  // write outlives the page, so going Back from a saved trip a moment after
  // changing it no longer loses the change.
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
      flush();
      if (timer.current) clearTimeout(timer.current);
      if (maxTimer.current) clearTimeout(maxTimer.current);
      setUnsaved(false);
    };
  }, []);
}
