/**
 * AI usage reporting — every Claude call's model, tokens and time, so
 * PostHog's AI observability can show what BlueMurr's AI costs, per feature
 * and per day.
 *
 * OFF unless POSTHOG_KEY is set (the same public project key the frontend
 * uses as NEXT_PUBLIC_POSTHOG_KEY). With no key nothing is sent.
 *
 * What is sent: the feature name ('chat', 'activities', …), the model, input /
 * output / cache token counts, latency and whether the call failed. Never the
 * prompt, the reply, the trip or anything the person typed.
 *
 * Fire-and-forget: a reporting failure never affects the AI call.
 */
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export type AiFeature =
  | 'chat'
  | 'chat_route'
  | 'chat_weather_writer'
  | 'chat_suggestions'
  | 'interpret'
  | 'activities'
  | 'restaurants'
  | 'suggest_for_vibe'
  | 'suggest_destinations'
  | 'destination_suggester'
  | 'destination_revision'
  | 'plan_converse'
  | 'preset_generation';

/**
 * USD per million tokens: input, output, cache read, cache write (5-minute).
 * Sources: platform.claude.com pricing (Sonnet 5.5 / Haiku 5.5 as relayed
 * 2026-11-28; cache write = 1.25x input); claude-sonnet-4-5 $3 / $15.
 * PostHog may not price the newer ids, so the event carries our own cost_usd.
 */
export const MODEL_PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** What one call cost, from its usage; null for a model without a price. */
export function costUsd(model: string | null | undefined, usage: any): number | null {
  const key = Object.keys(MODEL_PRICES).find((k) => String(model ?? '').startsWith(k));
  if (!key || !usage) return null;
  const p = MODEL_PRICES[key];
  const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const usd =
    (n(usage.input_tokens) * p.in +
      n(usage.output_tokens) * p.out +
      n(usage.cache_read_input_tokens) * p.cacheRead +
      n(usage.cache_creation_input_tokens) * p.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1e7) / 1e7;
}

/** Routing details carried on the event: which tier answered and why. */
export type AiMeta = { tier?: 0 | 1 | 2; routeReason?: string };

const host = () => (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');

/** The $ai_generation event PostHog prices from model + tokens. Exported for tests. */
export function aiGenerationEvent(feature: AiFeature, params: any, response: any, latencyMs: number, error?: any, meta: AiMeta = {}) {
  const usage = response?.usage ?? {};
  return {
    event: '$ai_generation',
    // Server-side calls have no browser id; one id per feature keeps the
    // AI dashboards grouped without identifying anyone.
    distinct_id: `bluemurr-backend:${feature}`,
    properties: {
      $process_person_profile: false,
      $ai_trace_id: randomUUID(),
      $ai_span_name: feature,
      $ai_provider: 'anthropic',
      $ai_model: response?.model ?? params?.model ?? null,
      $ai_input_tokens: usage.input_tokens ?? null,
      $ai_output_tokens: usage.output_tokens ?? null,
      $ai_cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
      $ai_cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
      $ai_latency: Math.round(latencyMs) / 1000,
      $ai_max_tokens: params?.max_tokens ?? null,
      $ai_stop_reason: response?.stop_reason ?? null,
      $ai_is_error: !!error,
      $ai_http_status: error ? (error?.status ?? 500) : 200,
      feature,
      cost_usd: costUsd(response?.model ?? params?.model, response?.usage),
      ...(meta.tier !== undefined ? { tier: meta.tier } : {}),
      ...(meta.routeReason ? { route_reason: meta.routeReason } : {}),
      environment: process.env.NODE_ENV ?? 'development',
    },
  };
}

function report(event: ReturnType<typeof aiGenerationEvent>): void {
  const key = process.env.POSTHOG_KEY;
  if (!key || process.env.NODE_ENV === 'test') return;
  void fetch(`${host()}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, timestamp: new Date().toISOString(), ...event }),
  }).catch((err) => logger.warn('AI usage report failed', { message: err?.message }));
}

/**
 * `anthropic.messages.create(params)`, reported. Same arguments, same result,
 * same errors — callers swap `anthropic.messages.create({` for
 * `createMessage(anthropic, 'feature', {` and nothing else changes.
 */
export async function createMessage(anthropic: any, feature: AiFeature, params: any, meta: AiMeta = {}): Promise<any> {
  const started = Date.now();
  try {
    const response = await anthropic.messages.create(params);
    try {
      report(aiGenerationEvent(feature, params, response, Date.now() - started, undefined, meta));
    } catch {
      /* never affect the call */
    }
    return response;
  } catch (err) {
    try {
      report(aiGenerationEvent(feature, params, null, Date.now() - started, err, meta));
    } catch {
      /* never affect the call */
    }
    throw err;
  }
}
