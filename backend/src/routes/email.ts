import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { getSupabase } from '../services/supabase';
import { verifyUnsubscribeToken } from '../services/email';
import { runEmailJobs } from '../services/emailJobs';
import { env } from '../config/env';

const router = Router();

/**
 * Public email endpoints — mounted WITHOUT requireAuth:
 *  - GET /unsubscribe is clicked from an email, no session exists.
 *  - POST /run-jobs is for schedulers, guarded by the CRON_SECRET header.
 */

const page = (title: string, body: string) =>
  `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f4f8;display:flex;justify-content:center;padding:64px 16px">
   <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;max-width:420px;text-align:center">
   <div style="font-size:20px;font-weight:700;color:#2563eb;margin-bottom:12px">BlueMurr</div>
   <h1 style="font-size:16px;color:#111827;margin:0 0 8px">${title}</h1>
   <p style="font-size:13px;color:#6b7280;margin:0">${body}</p></div></body></html>`;

// ─── GET /api/email/unsubscribe?token=… ──────────────────────
// Sets preferences.email.unsubscribed = true: stops invites + digests.
// Account-critical emails (deletion notices) are unaffected by design.
router.get(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? '');
    const userId = verifyUnsubscribeToken(token);
    if (!userId) {
      res.status(400).send(page('Invalid link', 'This unsubscribe link is invalid or damaged.'));
      return;
    }
    const supabase = getSupabase();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();
    const preferences = {
      ...(profile?.preferences ?? {}),
      email: { ...(profile?.preferences?.email ?? {}), unsubscribed: true },
    };
    const { error } = await supabase
      .from('user_profiles')
      .update({ preferences })
      .eq('id', userId);
    if (error) throw new AppError(500, error.message);

    res.send(
      page(
        "You're unsubscribed",
        'You will no longer receive invite or digest emails. Account-critical notices (like deletion confirmations) still apply.',
      ),
    );
  }),
);

// ─── POST /api/email/run-jobs ────────────────────────────────
// Scheduler entry point: grace-period reminders + weekly digests.
router.post(
  '/run-jobs',
  asyncHandler(async (req, res) => {
    if (!env.CRON_SECRET) throw new AppError(503, 'CRON_SECRET is not configured');
    if (req.headers['x-cron-secret'] !== env.CRON_SECRET) {
      throw new AppError(401, 'Unauthorized');
    }
    const result = await runEmailJobs();
    res.json({ success: true, ...result });
  }),
);

export default router;
