import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

/**
 * Server-side Supabase client using the SERVICE ROLE key.
 * This bypasses Row Level Security — NEVER expose this client
 * or its key to the browser.
 *
 * Use this for: admin queries, background jobs, webhooks,
 * trusted server-initiated writes.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      ...(process.env.SUPABASE_KEY_VIA_PROXY === 'true' ? { global: { fetch: proxyKeyFetch } } : {}),
    });
  }
  return client;
}

/**
 * Cloud dev containers only (SUPABASE_KEY_VIA_PROXY=true): the real service
 * key is never in this process — the network proxy adds it as the `apikey`
 * header — so SUPABASE_SERVICE_ROLE_KEY holds a placeholder. supabase-js also
 * sends `Authorization: Bearer <placeholder>`, which the API would reject, so
 * that one header is dropped and the gateway authorises on `apikey`.
 * A user's own token (e.g. auth.getUser(jwt)) is left untouched.
 */
const proxyKeyFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (headers.get('Authorization') === `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) headers.delete('Authorization');
  return fetch(input, { ...init, headers });
};
