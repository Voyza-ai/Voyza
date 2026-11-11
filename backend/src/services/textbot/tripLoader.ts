import { getSupabase } from '../supabase';
import { buildTripFromDb, liveTripTotal } from '../../utils/tripShape';
import type { MemberRole } from './store';
import type { TripLoader } from './types';

/**
 * READ-ONLY view of a saved trip for the text bot. Uses the same mapper as
 * GET /api/trips/:id (buildTripFromDb) and the same live total the results
 * page sends to the chat (lib/api.ts → withLiveTotal), so the bot's
 * `currentTrip` matches what the web chat sees.
 */
export class SupabaseTripLoader implements TripLoader {
  async load(tripId: string) {
    const supabase = getSupabase();
    const { data: trip, error } = await supabase.from('trips').select('*').eq('id', tripId).maybeSingle();
    if (error || !trip) return null;
    const [{ data: cities }, { data: transports }] = await Promise.all([
      supabase.from('cities').select('*').eq('trip_id', tripId).order('position', { ascending: true }),
      supabase.from('transports').select('*').eq('trip_id', tripId),
    ]);
    const full: any = buildTripFromDb(trip, cities ?? [], transports ?? []);
    full.totalCost = liveTripTotal(full.cities, full.origin);
    return { trip: full, title: String(full.title ?? trip.title ?? 'your trip'), updatedAt: String(trip.updated_at ?? '') };
  }

  /**
   * Same rules as canvas.ts getMemberRole: trips.user_id is the only owner;
   * a stale group_members 'owner' row is clamped to editor; invitations not
   * yet accepted grant nothing.
   */
  async members(tripId: string) {
    const supabase = getSupabase();
    const out = new Map<string, MemberRole>();
    const { data: trip } = await supabase.from('trips').select('user_id').eq('id', tripId).maybeSingle();
    if (!trip) return out;
    const { data: rows } = await supabase
      .from('group_members')
      .select('user_id, role, accepted_at')
      .eq('trip_id', tripId);
    for (const r of rows ?? []) {
      if (!r.user_id || !r.accepted_at) continue;
      const role: MemberRole = r.role === 'editor' || r.role === 'owner' ? 'editor' : 'viewer';
      out.set(r.user_id, role);
    }
    out.set(trip.user_id, 'owner');
    return out;
  }
}
