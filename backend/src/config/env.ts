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

  // Frontend URL for invite links and redirects
  FRONTEND_URL: z.string().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
