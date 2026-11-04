import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { getSupabase } from './supabase';
import { createNotification } from './notifications';
import { sendEmail, emailTemplates } from './email';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';

/**
 * Two-step account deletion.
 *
 *   1. requestDeletion()  — signed-in user asks to delete. We mint a
 *      single-use token, store only its SHA-256 (+ expiry) in
 *      user_profiles.preferences.deletionRequest, and email a link to
 *      FRONTEND_URL/settings/confirm-deletion?token=…
 *   2. confirmDeletion()  — the link's page POSTs the token back. Only then
 *      is deleted_at set (the existing 30-day grace period, reversible via
 *      POST /api/users/me/cancel-deletion).
 *
 * No new table/column: the pending request lives in the preferences jsonb
 * under a key the API never returns to clients (see stripPrivatePreferences).
 * Single-use because confirm (and cancel) clear it; a newer request replaces
 * the older hash, so only the latest emailed link works.
 */

export const DELETION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between two confirmation emails for the same user. */
export const DELETION_REQUEST_COOLDOWN_MS = 60 * 1000;

/** Server-only keys inside user_profiles.preferences. */
const PRIVATE_PREF_KEYS = ['deletionRequest'] as const;

export function stripPrivatePreferences(
  prefs: Record<string, any> | null | undefined,
): Record<string, any> {
  const out = { ...(prefs ?? {}) };
  for (const k of PRIVATE_PREF_KEYS) delete out[k];
  return out;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function makeDeletionToken(userId: string): { token: string; hash: string } {
  const secret = randomBytes(24).toString('base64url');
  return {
    token: `${Buffer.from(userId).toString('base64url')}.${secret}`,
    hash: sha256(secret),
  };
}

export function parseDeletionToken(token: string): { userId: string; secret: string } | null {
  const [b64, secret, extra] = String(token ?? '').split('.');
  if (!b64 || !secret || extra !== undefined) return null;
  const userId = Buffer.from(b64, 'base64url').toString();
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  return { userId, secret };
}

export function confirmDeletionUrl(token: string): string {
  return `${env.FRONTEND_URL}/settings/confirm-deletion?token=${encodeURIComponent(token)}`;
}

const scheduledFrom = (deletedAtIso: string) => {
  const d = new Date(deletedAtIso);
  d.setDate(d.getDate() + 30);
  return d.toISOString();
};

export type DeletionRequestResult =
  | { status: 'email_sent'; expiresAt: string }
  | { status: 'already_scheduled'; deletedAt: string; scheduledDeletionAt: string };

/** Step 1. Throws AppError on anonymized accounts, cooldown, or email failure. */
export async function requestDeletion(
  user: { id: string; email?: string | null },
  reason?: string,
): Promise<DeletionRequestResult> {
  const supabase = getSupabase();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('preferences, deleted_at, anonymized_at')
    .eq('id', user.id)
    .single();

  if (profile?.anonymized_at) throw new AppError(410, 'Account has already been anonymized');
  if (profile?.deleted_at) {
    return {
      status: 'already_scheduled',
      deletedAt: profile.deleted_at,
      scheduledDeletionAt: scheduledFrom(profile.deleted_at),
    };
  }
  if (!user.email) throw new AppError(400, 'Your account has no email address to confirm with');

  const prev = profile?.preferences?.deletionRequest;
  if (prev?.requestedAt && Date.now() - Date.parse(prev.requestedAt) < DELETION_REQUEST_COOLDOWN_MS) {
    throw new AppError(429, 'We just sent you a confirmation email — check your inbox, or try again in a minute.');
  }

  const { token, hash } = makeDeletionToken(user.id);
  const now = Date.now();
  const deletionRequest = {
    tokenHash: hash,
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DELETION_TOKEN_TTL_MS).toISOString(),
    reason: reason ?? null,
  };
  const { error } = await supabase
    .from('user_profiles')
    .update({ preferences: { ...(profile?.preferences ?? {}), deletionRequest } })
    .eq('id', user.id);
  if (error) throw new AppError(500, `Failed to start deletion: ${error.message}`);

  const link = confirmDeletionUrl(token);
  if (env.NODE_ENV === 'development') {
    // Local dev only: the link is also in the server log, so the flow can be
    // finished when the email transport is off or sandboxed.
    logger.info('Account deletion confirm link (dev only)', { userId: user.id, link });
  }

  const sent = await sendEmail({
    to: user.email,
    userId: user.id,
    type: 'deletion_confirm',
    ...emailTemplates.deletionConfirm(link),
  });
  if (!sent) {
    throw new AppError(503, "We couldn't send the confirmation email. Please try again later.");
  }
  return { status: 'email_sent', expiresAt: deletionRequest.expiresAt };
}

export type ScheduleResult = {
  deletedAt: string;
  scheduledDeletionAt: string;
  alreadyScheduled: boolean;
};

/** Step 2. Validates the emailed token and schedules the 30-day deletion. */
export async function confirmDeletion(token: string): Promise<ScheduleResult> {
  const parsed = parseDeletionToken(token);
  const invalid = new AppError(400, 'This confirmation link is invalid or has expired. Request a new one from Settings.');
  if (!parsed) throw invalid;

  const supabase = getSupabase();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('preferences, deleted_at, anonymized_at')
    .eq('id', parsed.userId)
    .single();
  if (!profile) throw invalid;
  if (profile.anonymized_at) throw new AppError(410, 'Account has already been anonymized');

  const req = profile.preferences?.deletionRequest;
  const expect = Buffer.from(String(req?.tokenHash ?? ''));
  const got = Buffer.from(sha256(parsed.secret));
  const matches = expect.length === got.length && timingSafeEqual(expect, got);
  if (!matches || !req?.expiresAt || Date.parse(req.expiresAt) < Date.now()) throw invalid;

  const preferences = stripPrivatePreferences(profile.preferences);

  // Already scheduled (e.g. via an older flow): keep the ORIGINAL date so the
  // grace period can't be extended, but still burn the token.
  if (profile.deleted_at) {
    await supabase.from('user_profiles').update({ preferences }).eq('id', parsed.userId);
    return {
      deletedAt: profile.deleted_at,
      scheduledDeletionAt: scheduledFrom(profile.deleted_at),
      alreadyScheduled: true,
    };
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('user_profiles')
    .update({
      deleted_at: nowIso,
      deletion_reason: req.reason ?? null,
      updated_at: nowIso,
      preferences,
    })
    .eq('id', parsed.userId);
  if (error) throw new AppError(500, `Failed to schedule deletion: ${error.message}`);

  const scheduledDeletionAt = scheduledFrom(nowIso);
  const deletionDateNice = new Date(scheduledDeletionAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  await createNotification({
    userId: parsed.userId,
    type: 'account_deletion_scheduled',
    title: 'Account deletion scheduled',
    body: `Your account will be permanently anonymized on ${deletionDateNice}. You can cancel any time before then from Settings.`,
    data: { deletedAt: nowIso, scheduledDeletionAt },
  });

  try {
    const { data } = await supabase.auth.admin.getUserById(parsed.userId);
    const email = data?.user?.email;
    if (email) {
      await sendEmail({
        to: email,
        userId: parsed.userId,
        type: 'deletion_scheduled',
        ...emailTemplates.deletionScheduled(deletionDateNice),
      });
    }
  } catch (err: any) {
    logger.warn('confirmDeletion: scheduled-email lookup failed (non-fatal)', { message: err?.message });
  }

  return { deletedAt: nowIso, scheduledDeletionAt, alreadyScheduled: false };
}

/**
 * Privacy default: may BlueMurr learn from this user's NEW trips
 * (trips.allow_recommendations)? Opt-out — true unless the user turned it
 * off in Settings → Privacy. Never throws; falls back to true (the column's
 * own default) so a lookup failure can't break a trip save.
 */
export async function recommendationDefaultFor(userId: string): Promise<boolean> {
  try {
    const { data } = await getSupabase()
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();
    return data?.preferences?.privacy?.allowRecommendations !== false;
  } catch {
    return true;
  }
}
