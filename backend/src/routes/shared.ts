import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { getSupabase } from '../services/supabase';
import { buildTripFromDb } from '../utils/tripShape';

/**
 * Read-only share links that open WITHOUT an account.
 *
 * A trip's share link (Share → "View only" → Copy link) used to open a
 * sign-in wall: the person it was sent to had to create an account before
 * seeing anything. This route hands that person the trip itself, read-only.
 *
 * What it will and won't answer:
 *  - Only the trip's CURRENT share-link token, and only while the link is in
 *    "view" mode. A link switched to suggest/edit still needs an account
 *    (those roles change the trip), and "Reset link" revokes it at once.
 *  - Never a personal email-invite token: those are for one named person.
 *  - Never an archived trip.
 *  - The trip as the results page draws it, minus who owns it (`ownerId`).
 *    Nothing about the members, the owner's account or the share settings.
 *
 * Every failure is the same 404 so a guess learns nothing about which part
 * was wrong.
 */
const router = Router();

const NOT_FOUND = 'This link is not a view-only link, or it has been reset';
const paramsSchema = z.object({ tripId: z.string().uuid() });
const querySchema = z.object({ token: z.string().uuid() });

/** Equal tokens, compared in constant time. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

router.get(
  '/:tripId',
  asyncHandler(async (req, res) => {
    const params = paramsSchema.safeParse(req.params);
    const query = querySchema.safeParse(req.query);
    if (!params.success || !query.success) throw new AppError(404, NOT_FOUND);
    const { tripId } = params.data;
    const { token } = query.data;
    const supabase = getSupabase();

    // The newest session holds the live link — the same row join-link reads.
    const { data: session } = await supabase
      .from('canvas_sessions')
      .select('share_token, share_mode')
      .eq('trip_id', tripId)
      .order('saved_at', { ascending: false })
      .limit(1)
      .single();
    if (!session || session.share_mode !== 'view' || !session.share_token || !sameToken(session.share_token, token)) {
      throw new AppError(404, NOT_FOUND);
    }

    const { data: trip } = await supabase.from('trips').select('*').eq('id', tripId).single();
    if (!trip || trip.status === 'archived') throw new AppError(404, NOT_FOUND);

    const { data: cities } = await supabase
      .from('cities')
      .select('*')
      .eq('trip_id', tripId)
      .order('position', { ascending: true });
    const { data: transports } = await supabase.from('transports').select('*').eq('trip_id', tripId);

    const { ownerId: _owner, ...shown } = buildTripFromDb(trip, cities ?? [], transports ?? []);
    res.set('Cache-Control', 'no-store');
    res.json({ trip: shown });
  }),
);

export default router;
