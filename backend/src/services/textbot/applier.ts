import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../supabase';
import { saveCanvasState } from '../../routes/canvas';
import { applyCityEdit, applyTransportChange, transportChangeApplies } from './tripEdits';
import type { ChatResult, ProposalApplier, TripLoader } from './types';

/**
 * Saves a texted YES to the trip, so it shows on the website — every change
 * the chat proposes:
 *   transport_change  any leg (flight out, train between cities, flight home),
 *                     incl. a new outbound that moves the first arrival date
 *   city_edit         add / remove / replace a city
 *   date_shift        pin a city's dates / minimum nights
 *
 * Same code as the website, start to finish:
 *   1. apply  — the results page's own Accept functions (frontend/lib
 *               cityEdit.ts, transportChange.ts), bundled via tripEdits.ts;
 *               a date_shift is its proposedTrip, as the website applies it;
 *   2. save   — the website's own save (routes/canvas.ts saveCanvasState:
 *               placeholder picks + hotel lookups for new cities, atomic
 *               cities/transports replace, trips row, canvas session).
 *
 * Safety: the proposal was priced on one version of the trip. Before writing
 * anything, ONE `UPDATE trips SET updated_at = now WHERE id = ? AND
 * updated_at = <that version>` claims it; if the trip was saved anywhere
 * since (an open website tab, another text), it matches nothing, nothing is
 * written, and Blue says so. A transport change is also re-checked against
 * the leg as it is now (transportChangeApplies), exactly like Accept.
 */

const CHANGED = "the trip was changed since I suggested this (maybe on the website). Ask me again and I'll re-check";
type Result = { ok: true } | { ok: false; reason: string };

export type SaveFn = (tripId: string, state: any, savedByUserId: string) => Promise<string>;

export class TripProposalApplier implements ProposalApplier {
  constructor(
    private trips: TripLoader,
    private db: SupabaseClient = getSupabase(),
    private now: () => number = () => Date.now(),
    private save: SaveFn = saveCanvasState,
  ) {}

  async apply(tripId: string, result: ChatResult, byUserId: string, expectedUpdatedAt: string | null): Promise<Result> {
    const p: any = (result as any).proposal;
    const kind = result.type === 'proposal' ? p?.kind : null;
    if (kind !== 'transport_change' && kind !== 'city_edit' && kind !== 'date_shift') {
      return { ok: false, reason: 'I don\'t know how to save that kind of change yet' };
    }
    if (!expectedUpdatedAt) return { ok: false, reason: "I couldn't tell which version of the trip it was priced on" };

    const loaded = await this.trips.load(tripId);
    if (!loaded) return { ok: false, reason: "I can't find the trip any more" };
    if (loaded.updatedAt !== expectedUpdatedAt) return { ok: false, reason: CHANGED };
    const trip: any = loaded.trip;

    // 1. Apply, with the website's own functions.
    let next: any;
    try {
      if (kind === 'transport_change') {
        if (!transportChangeApplies(trip, p)) return { ok: false, reason: CHANGED };
        next = applyTransportChange(trip, p);
      } else if (kind === 'city_edit') {
        next = applyCityEdit(trip, p);
      } else {
        next = p.proposedTrip;
      }
    } catch {
      return { ok: false, reason: "that change didn't fit the trip as it is now. Ask me again" };
    }
    if (!next || !Array.isArray(next.cities) || next.cities.length === 0) {
      return { ok: false, reason: "that change would leave the trip without cities" };
    }

    // 2. Claim the version the proposal was priced on (nothing else is written yet).
    const claim = await this.db
      .from('trips')
      .update({ updated_at: new Date(this.now()).toISOString() })
      .eq('id', tripId)
      .eq('updated_at', expectedUpdatedAt)
      .select('id');
    if (claim.error) return { ok: false, reason: 'saving failed on our side' };
    if (!claim.data || claim.data.length !== 1) return { ok: false, reason: CHANGED };

    // 3. Save exactly as the website does (lib/canvasHandoff.ts persistSavedTrip):
    //    the latest canvas session state, with this trip's cities and trip block.
    const sess = await this.db
      .from('canvas_sessions')
      .select('state')
      .eq('trip_id', tripId)
      .order('saved_at', { ascending: false })
      .limit(1);
    const prev: any = (sess.data as any[] | null)?.[0]?.state ?? {};
    const state = {
      ...prev,
      cities: next.cities,
      trip: {
        ...(prev.trip ?? {}),
        ...(next.title ? { title: next.title } : {}),
        travelers: next.travelers,
        ...(next.origin ? { origin: next.origin, returnToHome: next.returnToHome ?? true } : {}),
      },
    };
    try {
      await this.save(tripId, state, byUserId);
    } catch {
      return { ok: false, reason: 'saving failed part-way on our side, so please open the trip and check it' };
    }
    return { ok: true };
  }
}
