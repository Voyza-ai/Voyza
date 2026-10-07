import { createClient, User } from '@supabase/supabase-js';
import { processLock } from '@supabase/auth-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = supabaseUrl
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        // Use the in-memory process lock instead of the Web Locks API.
        // navigatorLock throws "lock was stolen by another request" when
        // concurrent calls (e.g. React StrictMode double-mount) contend for
        // the auth token. processLock serializes within the tab without the
        // steal semantics, so it never surfaces those AbortErrors.
        lock: processLock,
      },
    })
  : (null as unknown as ReturnType<typeof createClient>);

export async function getCurrentUser(): Promise<User | null> {
  // Fast path: read from Zustand store if available
  try {
    const { useAuthStore } = await import('@/store/authStore');
    const storeUser = useAuthStore.getState().user;
    if (storeUser) return storeUser;
  } catch {
    // Store not available (e.g. during SSR)
  }

  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export async function getAuthHeader(): Promise<Record<string, string>> {
  // Fast path: read from Zustand store — but only while the token is
  // still comfortably valid. An expired store token was being sent as-is
  // (401s on every call after a long session); past expiry we fall
  // through to getSession(), which refreshes it.
  try {
    const { useAuthStore } = await import('@/store/authStore');
    const session = useAuthStore.getState().session;
    const fresh =
      !session?.expires_at || session.expires_at * 1000 > Date.now() + 60_000;
    if (session?.access_token && fresh) {
      return { Authorization: `Bearer ${session.access_token}` };
    }
  } catch {
    // Store not available
  }

  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

/**
 * Force a session refresh (used after a 401) and return fresh auth
 * headers, or null if the session can't be refreshed (truly signed out).
 * Also pushes the new session into the auth store so later fast-path
 * reads use it.
 */
export async function refreshAuthHeader(): Promise<Record<string, string> | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.refreshSession();
    const session = data?.session;
    if (!session?.access_token) return null;
    try {
      const { useAuthStore } = await import('@/store/authStore');
      useAuthStore.getState().setSession(session);
    } catch {
      // store unavailable — header still works for this retry
    }
    return { Authorization: `Bearer ${session.access_token}` };
  } catch {
    return null;
  }
}
