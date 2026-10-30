import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';

/**
 * How long one Anthropic attempt may take, and how many times a failed one is
 * retried.
 *
 * The SDK's own defaults (0.32.1) are a 10-minute timeout and 2 retries, and a
 * timeout is itself retried — so a stalled call held its route for up to
 * 3 × 600 s, about half an hour, before the user saw anything. The frontend
 * sets no timeout of its own, so this is the only bound there is.
 *
 * Sized against every `max_tokens` the app sends, at the SDK's OWN planning
 * figure for a non-streaming call, 128,000 output tokens an hour (~35.6 tok/s;
 * `_calculateNonstreamingTimeout` in later SDKs):
 *
 *   max_tokens  call                                       full-length worst case
 *   2048        suggest-for-vibe (destinationSuggester)    57.6 s
 *   1024        interpret, chat, activities, restaurants   28.8 s
 *    700        converse (every planner turn)              19.7 s
 *    512        suggest-destinations                       14.4 s
 *    400        chat-suggestions                           11.3 s
 *
 * so 90 s covers the largest one at its full length with half a minute to
 * spare for queueing and the prompt. What production actually measured is far
 * below that: activities and restaurants 6.9–8.4 s, chat-suggestions 2.5 s.
 *
 * One retry, not two. The retry is what rescues a dropped connection or a
 * 529 overload, and one does that; the second mostly re-waits on an outage.
 * Worst case per call is now ~3 minutes (90 s + backoff + 90 s), not 30.
 *
 * The preset generator script (scripts/generatePresets.ts) asks for 4000
 * tokens — 112 s at that same figure — and is the one caller that may need
 * `{ timeout }` passed per request if it starts timing out.
 */
export const ANTHROPIC_TIMEOUT_MS = 90_000;
export const ANTHROPIC_MAX_RETRIES = 1;

/**
 * Anthropic client for AI-driven planning, chat, and content generation.
 * Keep all model calls server-side — the API key must never reach the browser.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: ANTHROPIC_TIMEOUT_MS,
      maxRetries: ANTHROPIC_MAX_RETRIES,
    });
  }
  return client;
}

/**
 * Returns the Anthropic client, or null when no real API key is
 * configured (placeholder envs, tests, CI). Callers should check for
 * null and fall back to a mock / default path rather than crash — the
 * app should work without the API key, just without AI features.
 *
 * Shared here (rather than duplicated in each route) so every caller
 * uses the same key-is-placeholder heuristics.
 */
export function getAnthropicSafe(): Anthropic | null {
  const key = env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_api_key' || key.startsWith('your_')) return null;
  try {
    return getAnthropic();
  } catch {
    return null;
  }
}

/** Default model for planning/chat. Update here to roll out across the app. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';
