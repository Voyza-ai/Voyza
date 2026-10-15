import { getSupabase } from './supabase';
import { logger } from '../utils/logger';
import { emailTemplates, sendEmail, unsubscribeUrlFor } from './email';

/**
 * Scheduled email work, triggered by POST /api/email/run-jobs (guarded by
 * CRON_SECRET). Wire any scheduler to hit that endpoint daily — Railway
 * cron, GitHub Actions, or pg_cron+http. Both jobs are idempotent:
 * re-running the same day cannot double-send.
 *
 *  - Grace reminders: accounts pending deletion with ≤7 days left (i.e.
 *    around day 23 of the 30-day window) get one reminder email, marked in
 *    preferences.email.graceReminderSent so it sends exactly once.
 *  - Weekly digest: opt-in users (preferences.email.digest = true) with
 *    unread notifications get a summary, at most once per 6 days
 *    (preferences.email.digestSentAt).
 */

const DAY_MS = 86_400_000;
const GRACE_DAYS = 30;
const REMIND_AT_DAYS_LEFT = 7;

const niceDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

async function emailOf(userId: string): Promise<string | null> {
  const { data } = await getSupabase().auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

async function mergeEmailPrefs(userId: string, prev: Record<string, any> | null, patch: Record<string, any>) {
  const preferences = { ...(prev ?? {}), email: { ...(prev?.email ?? {}), ...patch } };
  await getSupabase().from('user_profiles').update({ preferences }).eq('id', userId);
}

export async function runGraceReminders(now = new Date()): Promise<number> {
  const supabase = getSupabase();
  const { data: pending } = await supabase
    .from('user_profiles')
    .select('id, preferences, deleted_at')
    .not('deleted_at', 'is', null)
    .is('anonymized_at', null);

  let sent = 0;
  for (const p of pending ?? []) {
    try {
      if (p.preferences?.email?.graceReminderSent) continue;
      const deletionAt = new Date(new Date(p.deleted_at).getTime() + GRACE_DAYS * DAY_MS);
      const daysLeft = Math.ceil((deletionAt.getTime() - now.getTime()) / DAY_MS);
      if (daysLeft > REMIND_AT_DAYS_LEFT || daysLeft < 0) continue;

      const to = await emailOf(p.id);
      if (!to) continue;
      const tpl = emailTemplates.graceReminder(niceDate(deletionAt), daysLeft);
      const ok = await sendEmail({ to, type: 'grace_reminder', userId: p.id, ...tpl });
      if (ok) {
        await mergeEmailPrefs(p.id, p.preferences, { graceReminderSent: true });
        sent++;
      }
    } catch (err: any) {
      logger.warn('grace reminder failed for one user (non-fatal)', { message: err?.message });
    }
  }
  return sent;
}

export async function runWeeklyDigests(now = new Date()): Promise<number> {
  const supabase = getSupabase();
  // Opt-in only (digest emails default OFF).
  const { data: users } = await supabase
    .from('user_profiles')
    .select('id, preferences')
    .eq('preferences->email->>digest', 'true')
    .is('deleted_at', null);

  let sent = 0;
  for (const u of users ?? []) {
    try {
      const last = u.preferences?.email?.digestSentAt;
      if (last && now.getTime() - new Date(last).getTime() < 6 * DAY_MS) continue;

      const { data: unread } = await supabase
        .from('notifications')
        .select('title, body')
        .eq('user_id', u.id)
        .is('read_at', null)
        .order('created_at', { ascending: false })
        .limit(5);
      if (!unread || unread.length === 0) continue;

      const to = await emailOf(u.id);
      if (!to) continue;
      const tpl = emailTemplates.digest(unread, unsubscribeUrlFor(u.id));
      const ok = await sendEmail({ to, type: 'digest', userId: u.id, ...tpl });
      if (ok) {
        await mergeEmailPrefs(u.id, u.preferences, { digestSentAt: now.toISOString() });
        sent++;
      }
    } catch (err: any) {
      logger.warn('digest failed for one user (non-fatal)', { message: err?.message });
    }
  }
  return sent;
}

export async function runEmailJobs(now = new Date()) {
  const remindersSent = await runGraceReminders(now);
  const digestsSent = await runWeeklyDigests(now);
  return { remindersSent, digestsSent };
}
