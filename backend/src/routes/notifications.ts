import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { getSupabase } from '../services/supabase';
import { AppError } from '../middleware/error';

const router = Router();

/**
 * In-app notifications (the navbar bell). Rows are created by the
 * notification service (services/notifications.ts) and by the SQL-side
 * anonymize job — this router only reads and mutates the recipient's own.
 *
 * The backend uses the service-role client, which bypasses RLS, so EVERY
 * query here filters .eq('user_id', user.id) — the RLS policies in
 * migration 006 protect direct supabase-js access (Realtime), not these
 * routes.
 */

// ─── GET /api/notifications ──────────────────────────────────
// Newest-first list + unread count for the badge.
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const { limit } = listSchema.parse(req.query);
    const supabase = getSupabase();

    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new AppError(500, error.message);

    // Served by the partial unread index — head:true returns count only.
    const { count, error: countError } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null);
    if (countError) throw new AppError(500, countError.message);

    res.json({ notifications: notifications ?? [], unreadCount: count ?? 0 });
  }),
);

// ─── PATCH /api/notifications/read-all ───────────────────────
// MUST be declared before PATCH /:id or "read-all" matches as an id.
router.patch(
  '/read-all',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('read_at', null)
      .select('id');
    if (error) throw new AppError(500, error.message);

    res.json({ success: true, updated: data?.length ?? 0 });
  }),
);

// ─── PATCH /api/notifications/:id ────────────────────────────
// Marks one notification read. 404 covers both "doesn't exist" and
// "not yours" — no information leak about other users' rows.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id as string)
      .eq('user_id', user.id)
      .select()
      .single();
    if (error || !data) throw new AppError(404, 'Notification not found');

    res.json({ notification: data });
  }),
);

// ─── DELETE /api/notifications/:id ───────────────────────────
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', req.params.id as string)
      .eq('user_id', user.id);
    if (error) throw new AppError(500, error.message);

    res.json({ success: true });
  }),
);

export default router;
