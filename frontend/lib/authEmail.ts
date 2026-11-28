import { supabase } from './supabase';

/**
 * A path on this site worth returning to after signing in, or null. Resolved
 * exactly as the browser will ("//evil.com", "/\evil.com" and "/\t/evil.com"
 * all leave the origin) and the landing page and auth screens are skipped:
 * returning there looks like the sign-in did nothing.
 */
// Parsed against a fixed stand-in origin, not window's: the answer is then the
// same on the server and in the browser (a window-only answer made the sign-up
// links differ between the two — a hydration mismatch on /auth/login).
const HERE = 'http://same-origin.invalid';
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, HERE);
    if (url.origin !== HERE) return null;
    if (url.pathname === '/' || url.pathname.startsWith('/auth/')) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/**
 * Where the "confirm your email" link lands: the auth callback, which signs
 * the new account in and goes on to `next` (e.g. the shared trip they were
 * invited to). Without it the link went to the Site URL, so a new user
 * confirmed and ended up somewhere else, signed out.
 */
export function confirmRedirectUrl(next?: string | null): string {
  const base = `${window.location.origin}/auth/callback`;
  const safe = safeReturnPath(next);
  return safe ? `${base}?next=${encodeURIComponent(safe)}` : base;
}

/** Supabase's sign-in error for an account whose email isn't confirmed yet. */
export function isUnconfirmedEmailError(message: string | null | undefined): boolean {
  return !!message && /email not confirmed/i.test(message);
}

/** Sends the sign-up confirmation email again. Returns an error message, or null. */
export async function resendConfirmation(email: string, next?: string | null): Promise<string | null> {
  if (!supabase) return 'Authentication is not configured';
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: confirmRedirectUrl(next) },
  });
  return error ? error.message : null;
}
