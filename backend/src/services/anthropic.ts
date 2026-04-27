import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';

/**
 * Anthropic client for AI-driven planning, chat, and content generation.
 * Keep all model calls server-side — the API key must never reach the browser.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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
