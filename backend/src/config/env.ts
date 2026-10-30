import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env BEFORE reading process.env.
// Override any empty-string values in the parent shell (e.g. the parent
// process leaks `ANTHROPIC_API_KEY=""` and dotenv by default won't touch
// already-set keys, even empty ones). We only override keys whose current
// value is empty so production deployments (Railway, Vercel) still win.
const parsedDotenv = loadDotenv().parsed ?? {};
for (const [key, value] of Object.entries(parsedDotenv)) {
  if (!process.env[key]) process.env[key] = value;
}

/**
 * Central env validation.
 * Parsed once at startup — if required vars are missing or malformed,
 * the process exits before serving any traffic.
 *
 * Add new vars here, not by reaching into `process.env` directly.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),


  // Supabase (server-side only — service role has full DB access)
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Anthropic — optional so backend boots without it
  ANTHROPIC_API_KEY: z.string().optional(),

  // Providers — optional during early development
  DUFFEL_ACCESS_TOKEN: z.string().optional(),

  // Hotels (RapidAPI / Booking.com)
  RAPIDAPI_KEY: z.string().optional(),

  // Deutsche Bahn REST API
  DB_REST_BASE_URL: z.string().default('https://v6.db.transport.rest'),

  // All Aboard (EU rail, GraphQL). Key is test-scoped for now; the URL
  // defaults to their test gateway — switch to api-gateway.allaboard.eu
  // at go-live together with a live-scoped key.
  ALLABOARD_API_KEY: z.string().optional(),
  ALLABOARD_API_URL: z.string().default('https://test.api-gateway.allaboard.eu'),

  // Frontend URL for invite links and redirects
  FRONTEND_URL: z.string().default('http://localhost:3000'),

  // Email transport (Resend). No key → email silently disabled (in-app
  // notifications still work). EMAIL_FROM's default is Resend's sandbox
  // sender, usable before a domain is verified.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('BlueMurr <onboarding@resend.dev>'),
  // Public URL of THIS API (unsubscribe links in emails point here).
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  // Shared secret for POST /api/email/run-jobs (grace reminders + digest).
  CRON_SECRET: z.string().optional(),

  // Browse preset price refresh (services/presets.ts) — the in-process
  // 6-hourly scheduler AND POST /api/presets/run-refresh. OFF unless set to
  // exactly "true": the refresh writes into the one Supabase project that
  // also holds real trips, so a laptop running `npm run dev` must never
  // start it by accident. Turn it on in ONE deployment only.
  PRESET_REFRESH_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.trim().toLowerCase() === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);

  // Under test, THROW rather than exit.
  //
  // `process.exit(1)` at import time is right for a server — a process with a
  // half-configured environment should die loudly instead of serving wrong
  // answers. Inside Jest it is a different thing entirely: it kills the
  // runner, not the test. In parallel mode that takes out a worker and the
  // suite reports "child process exceptions"; with `--runInBand` the whole
  // run dies at the first such suite and prints no summary at all, so one
  // unconfigured suite hides the result of every other one.
  //
  // A throw gives Jest something it can report: that suite fails with the
  // missing variables named, and the other 46 still run. Production behaviour
  // is unchanged.
  if (process.env.NODE_ENV === 'test') {
    const fields = Object.keys(parsed.error.flatten().fieldErrors).join(', ');
    throw new Error(
      `Invalid environment variables: ${fields}. This suite needs them mocked — ` +
        `see the jest.mock('../config/env', ...) at the top of legPriceCache.test.ts.`,
    );
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
