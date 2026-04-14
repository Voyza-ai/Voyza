import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { getSupabase } from '../services/supabase';
import { env } from '../config/env';

const router = Router();

// Helper: extract user from Supabase JWT
async function getUserFromToken(authHeader?: string) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const supabase = getSupabase();
  const { data } = await supabase.auth.getUser(token);
  return data?.user ?? null;
}

// Helper: check group membership
async function getMemberRole(tripId: string, userId: string) {
  const supabase = getSupabase();

  // Check if user is trip owner
  const { data: trip } = await supabase
    .from('trips')
    .select('user_id')
    .eq('id', tripId)
    .single();

  if (trip?.user_id === userId) return 'owner';

  // Check group_members
  const { data: member } = await supabase
    .from('group_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', userId)
    .single();

  return member?.role ?? null;
}

// ─── POST /api/canvas/:tripId/session ────────────────────────
router.post(
  '/:tripId/session',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role) throw new AppError(403, 'Not a member of this trip');

    const supabase = getSupabase();

    // Find or create session
    const { data: existing } = await supabase
      .from('canvas_sessions')
      .select('*')
      .eq('trip_id', tripId)
      .order('saved_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      res.json({ session: existing, role });
      return;
    }

    // Create new session with current trip state
    const { data: trip } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single();

    const { data: cities } = await supabase
      .from('cities')
      .select('*')
      .eq('trip_id', tripId)
      .order('position');

    const { data: transports } = await supabase
      .from('transports')
      .select('*')
      .eq('trip_id', tripId);

    const state = { trip, cities, transports };
    const { data: session } = await supabase
      .from('canvas_sessions')
      .insert({
        trip_id: tripId,
        state,
        last_saved_by: user.id,
      })
      .select()
      .single();

    res.json({ session, role });
  }),
);

// ─── POST /api/canvas/:tripId/save ──────────────────────────
router.post(
  '/:tripId/save',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (role !== 'owner') throw new AppError(403, 'Only the trip owner can save');

    const { state } = req.body;
    if (!state) throw new AppError(400, 'Canvas state is required');

    const supabase = getSupabase();

    // Update canvas session
    await supabase
      .from('canvas_sessions')
      .upsert({
        trip_id: tripId,
        state,
        last_saved_by: user.id,
        saved_at: new Date().toISOString(),
      });

    // Apply canvas changes to live trip tables
    if (state.cities && Array.isArray(state.cities)) {
      // Delete existing cities and reinsert
      await supabase.from('cities').delete().eq('trip_id', tripId);
      const cityRows = state.cities.map((city: any, idx: number) => ({
        ...city,
        trip_id: tripId,
        position: idx,
        id: city.id ?? undefined,
      }));
      if (cityRows.length > 0) {
        await supabase.from('cities').insert(cityRows);
      }
    }

    if (state.transports && Array.isArray(state.transports)) {
      await supabase.from('transports').delete().eq('trip_id', tripId);
      const transportRows = state.transports.map((t: any) => ({
        ...t,
        trip_id: tripId,
      }));
      if (transportRows.length > 0) {
        await supabase.from('transports').insert(transportRows);
      }
    }

    // Update trip metadata
    if (state.trip) {
      await supabase
        .from('trips')
        .update({
          total_cost: state.trip.total_cost ?? state.trip.totalCost,
          updated_at: new Date().toISOString(),
        })
        .eq('id', tripId);
    }

    res.json({ saved: true, savedAt: new Date().toISOString() });
  }),
);

// ─── GET /api/canvas/:tripId/suggestions ─────────────────────
router.get(
  '/:tripId/suggestions',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role) throw new AppError(403, 'Not a member of this trip');

    const supabase = getSupabase();
    const { data } = await supabase
      .from('canvas_suggestions')
      .select('*')
      .eq('trip_id', tripId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    res.json({ suggestions: data ?? [] });
  }),
);

// ─── POST /api/canvas/:tripId/suggestions ────────────────────
const suggestionSchema = z.object({
  type: z.enum(['add_city', 'comment', 'reaction']),
  payload: z.any(),
});

router.post(
  '/:tripId/suggestions',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role || role === 'viewer') {
      throw new AppError(403, 'Viewers cannot submit suggestions');
    }

    const { type, payload } = suggestionSchema.parse(req.body);
    const supabase = getSupabase();

    const { data } = await supabase
      .from('canvas_suggestions')
      .insert({
        trip_id: tripId,
        suggested_by: user.id,
        type,
        payload,
        status: 'pending',
      })
      .select()
      .single();

    res.status(201).json({ suggestion: data });
  }),
);

// ─── PATCH /api/canvas/:tripId/suggestions/:suggestionId ─────
const patchSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

router.patch(
  '/:tripId/suggestions/:suggestionId',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const suggestionId = req.params.suggestionId as string;
    const role = await getMemberRole(tripId, user.id);
    if (role !== 'owner') throw new AppError(403, 'Only the trip owner can approve/reject');

    const { status } = patchSchema.parse(req.body);
    const supabase = getSupabase();

    const { data: suggestion } = await supabase
      .from('canvas_suggestions')
      .update({ status })
      .eq('id', suggestionId)
      .eq('trip_id', tripId)
      .select()
      .single();

    // If approved add_city, add to canvas state
    if (status === 'approved' && suggestion?.type === 'add_city') {
      const { data: session } = await supabase
        .from('canvas_sessions')
        .select('state')
        .eq('trip_id', tripId)
        .order('saved_at', { ascending: false })
        .limit(1)
        .single();

      if (session?.state) {
        const cities = (session.state as any).cities ?? [];
        cities.push(suggestion.payload);
        await supabase
          .from('canvas_sessions')
          .update({ state: { ...session.state, cities } })
          .eq('trip_id', tripId);
      }
    }

    res.json({ suggestion });
  }),
);

// ─── POST /api/canvas/:tripId/invite ─────────────────────────
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['editor', 'suggester', 'viewer']),
});

router.post(
  '/:tripId/invite',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const memberRole = await getMemberRole(tripId, user.id);
    if (memberRole !== 'owner') throw new AppError(403, 'Only the trip owner can invite');

    const { email, role } = inviteSchema.parse(req.body);
    const supabase = getSupabase();

    const { data } = await supabase
      .from('group_members')
      .insert({
        trip_id: tripId,
        invited_email: email,
        role,
      })
      .select()
      .single();

    const inviteLink = `${env.FRONTEND_URL}/canvas/join/${data?.invite_token}`;
    res.status(201).json({ member: data, inviteLink });
  }),
);

// ─── GET /api/canvas/join/:token ─────────────────────────────
router.get(
  '/join/:token',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    const { token } = req.params;
    const supabase = getSupabase();

    const { data: member } = await supabase
      .from('group_members')
      .select('*, trip_id')
      .eq('invite_token', token)
      .single();

    if (!member) throw new AppError(404, 'Invalid invite link');

    // Link user if authenticated
    if (user && !member.accepted_at) {
      await supabase
        .from('group_members')
        .update({
          user_id: user.id,
          accepted_at: new Date().toISOString(),
        })
        .eq('id', member.id);
    }

    res.redirect(`${env.FRONTEND_URL}/results?trip=${member.trip_id}&canvas=true`);
  }),
);

export default router;
