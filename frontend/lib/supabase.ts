import { createClient, User } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = supabaseUrl
  ? createClient(supabaseUrl, supabaseAnonKey)
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
  // Fast path: read from Zustand store if available
  try {
    const { useAuthStore } = await import('@/store/authStore');
    const session = useAuthStore.getState().session;
    if (session?.access_token) {
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
