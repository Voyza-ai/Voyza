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
    });
  }
  return client;
}
