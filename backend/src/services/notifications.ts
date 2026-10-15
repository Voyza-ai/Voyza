import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

/**
 * In-app notification creation, used by every trigger site (deletion
 * requested, ownership transferred, suggestion decided, canvas invite).
 * The 'trip_owner_anonymized' type is created SQL-side inside
 * anonymize_expired_deletions() (migration 006) but lives in this union so
 * the whole system shares one type vocabulary.
 */
export type NotificationType =
  | 'account_deletion_scheduled'
  | 'trip_owner_anonymized'
  | 'ownership_transferred'
  | 'suggestion_decided'
  | 'canvas_invite';

export type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
};

/**
 * Preference check against user_profiles.preferences (jsonb). Opt-OUT
 * semantics: every type defaults ON; only an explicit `false` at
 * preferences.notifications[type] disables it. There is no settings UI yet —
 * enforcing here means one can be added later without touching triggers.
 * Exported for unit tests.
 */
export function isNotificationTypeEnabled(
  preferences: Record<string, unknown> | null | undefined,
  type: NotificationType,
): boolean {
  const prefs = (preferences as any)?.notifications;
  if (!prefs || typeof prefs !== 'object') return true;
  return prefs[type] !== false;
}

/**
 * Insert an in-app notification for a user, respecting their preferences.
 *
 * NEVER throws. Notifications are side effects of more important writes
 * (a transfer, an invite, a deletion request) — a notification failure must
 * never break its host route, so every failure path is a logger.warn.
 *
 * Recipients pending deletion are skipped — except for
 * 'account_deletion_scheduled', which by definition fires right after
 * deleted_at is set on the recipient themselves.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  try {
    const supabase = getSupabase();

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('preferences, deleted_at')
      .eq('id', input.userId)
      .single();

    if (profileError || !profile) {
      logger.warn('createNotification: no profile for recipient — skipped', {
        userId: input.userId,
        type: input.type,
      });
      return;
    }

    if (profile.deleted_at && input.type !== 'account_deletion_scheduled') {
      return; // account pending deletion — don't pile on notifications
    }

    if (!isNotificationTypeEnabled(profile.preferences, input.type)) {
      return; // user opted out of this type
    }

    const { error } = await supabase.from('notifications').insert({
      user_id: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? {},
    });

    if (error) {
      logger.warn('createNotification: insert failed (non-fatal)', {
        message: error.message,
        type: input.type,
      });
    }
  } catch (err: any) {
    logger.warn('createNotification failed (non-fatal)', {
      message: err?.message,
      type: input.type,
    });
  }
}
