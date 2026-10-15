import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

/**
 * Transactional email via Resend (plain fetch, no SDK). Same contract as
 * the notification service: sends NEVER throw — email is a side effect of
 * more important writes, so every failure path is a logger.warn and the
 * host route carries on. With no RESEND_API_KEY the transport is disabled
 * and every send quietly no-ops (local dev default).
 *
 * Preferences live in user_profiles.preferences.email:
 *   { unsubscribed?: boolean, canvas_invite?: boolean, digest?: boolean }
 * - deletion_scheduled / grace_reminder: account-critical, ALWAYS sent
 *   (unsubscribe never blocks "your account is being deleted").
 * - canvas_invite: opt-out (default ON), blocked by unsubscribed.
 * - digest: opt-IN (default OFF), blocked by unsubscribed.
 */

export type EmailType =
  | 'deletion_scheduled'
  | 'grace_reminder'
  | 'canvas_invite'
  | 'digest';

const CRITICAL: EmailType[] = ['deletion_scheduled', 'grace_reminder'];

export function isEmailEnabled(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

export function isEmailTypeEnabled(
  preferences: Record<string, any> | null | undefined,
  type: EmailType,
): boolean {
  if (CRITICAL.includes(type)) return true;
  const e = preferences?.email;
  if (e?.unsubscribed === true) return false;
  if (type === 'digest') return e?.digest === true;
  return e?.[type] !== false;
}

// ── Unsubscribe tokens ──────────────────────────────────────────────────
// Stateless HMAC over the user id — no table needed, links never expire.
// Secret defaults to the service-role key (already secret, already set).

const secret = () => env.CRON_SECRET ?? env.SUPABASE_SERVICE_ROLE_KEY;

export function unsubscribeToken(userId: string): string {
  const sig = createHmac('sha256', secret()).update(userId).digest('hex').slice(0, 32);
  return `${Buffer.from(userId).toString('base64url')}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const userId = Buffer.from(b64, 'base64url').toString();
    const expect = createHmac('sha256', secret()).update(userId).digest('hex').slice(0, 32);
    if (sig.length !== expect.length) return null;
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) ? userId : null;
  } catch {
    return null;
  }
}

// ── Templates ───────────────────────────────────────────────────────────

const BLUE = '#2563eb';

function shell(title: string, bodyHtml: string, unsubscribeUrl?: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f0f4f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px">
    <div style="font-size:22px;font-weight:700;color:${BLUE};margin-bottom:16px">BlueMurr</div>
    <div style="background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
      <h1 style="font-size:17px;margin:0 0 12px;color:#111827">${title}</h1>
      <div style="font-size:14px;line-height:1.6;color:#374151">${bodyHtml}</div>
    </div>
    <div style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">
      Sent by BlueMurr${
        unsubscribeUrl
          ? ` · <a href="${unsubscribeUrl}" style="color:#9ca3af">Unsubscribe from these emails</a>`
          : ''
      }
    </div>
  </div></body></html>`;
}

const btn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;margin-top:12px;padding:10px 18px;background:${BLUE};color:#fff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">${label}</a>`;

export const emailTemplates = {
  deletionScheduled(dateNice: string) {
    return {
      subject: 'Your BlueMurr account deletion is scheduled',
      html: shell(
        'Account deletion scheduled',
        `<p>Your account will be permanently deleted on <strong>${dateNice}</strong>.</p>
         <p>Until then everything keeps working, and you can cancel any time from
         your profile menu in the app. After that date your personal details are
         permanently erased and this cannot be undone.</p>
         <p>If this wasn't you, sign in and cancel the deletion now.</p>`,
      ),
    };
  },

  graceReminder(dateNice: string, daysLeft: number) {
    return {
      subject: `Reminder: your BlueMurr account will be deleted in ${daysLeft} days`,
      html: shell(
        'Your account deletion is coming up',
        `<p>Your account is scheduled for permanent deletion on
         <strong>${dateNice}</strong> — about ${daysLeft} days from now.</p>
         <p>If you've changed your mind, sign in and choose
         "Keep my account" from your profile menu before then. Otherwise no
         action is needed.</p>`,
      ),
    };
  },

  canvasInvite(inviterEmail: string | null, tripTitle: string | null, role: string, link: string, unsubscribeUrl?: string) {
    const who = inviterEmail ?? 'A BlueMurr user';
    const trip = tripTitle ? `"${tripTitle}"` : 'a trip';
    return {
      subject: `${who} invited you to plan ${trip} on BlueMurr`,
      html: shell(
        "You're invited to plan a trip",
        `<p><strong>${who}</strong> invited you to collaborate on ${trip} as
         <strong>${role}</strong>.</p>
         <p>Open the trip canvas to join — you can edit, suggest, and plan
         together in real time.</p>
         ${btn(link, 'Open the trip')}`,
        unsubscribeUrl,
      ),
    };
  },

  digest(items: Array<{ title: string; body: string | null }>, unsubscribeUrl?: string) {
    const rows = items
      .map(
        (i) =>
          `<li style="margin-bottom:8px"><strong>${i.title}</strong>${
            i.body ? `<br><span style="color:#6b7280">${i.body}</span>` : ''
          }</li>`,
      )
      .join('');
    return {
      subject: `You have ${items.length} unread notification${items.length === 1 ? '' : 's'} on BlueMurr`,
      html: shell(
        'Your week on BlueMurr',
        `<p>While you were away:</p><ul style="padding-left:18px">${rows}</ul>
         ${btn(env.FRONTEND_URL + '/main', 'Open BlueMurr')}`,
        unsubscribeUrl,
      ),
    };
  },
};

// ── Send ────────────────────────────────────────────────────────────────

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  type: EmailType;
  /** When set, the recipient's stored preferences are enforced. Absent
   *  (e.g. inviting an email with no account) type defaults apply. */
  userId?: string;
};

/** Returns true only when the email was accepted by the transport. */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  try {
    if (!isEmailEnabled()) return false;

    let preferences: Record<string, any> | null = null;
    if (input.userId) {
      const { data } = await getSupabase()
        .from('user_profiles')
        .select('preferences')
        .eq('id', input.userId)
        .single();
      preferences = data?.preferences ?? null;
    }
    if (!isEmailTypeEnabled(preferences, input.type)) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [input.to],
          subject: input.subject,
          html: input.html,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn('sendEmail: transport rejected (non-fatal)', {
          status: res.status,
          type: input.type,
        });
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    logger.warn('sendEmail failed (non-fatal)', { message: err?.message, type: input.type });
    return false;
  }
}

export function unsubscribeUrlFor(userId: string): string {
  return `${env.API_PUBLIC_URL}/api/email/unsubscribe?token=${unsubscribeToken(userId)}`;
}
