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

/** Default model for planning/chat. Update here to roll out across the app. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
