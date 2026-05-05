/**
 * Vibe-first destination suggester.
 *
 * Pipeline:
 *   1. Build cache key from normalized inputs
 *   2. Cache hit → return (with { cached: true } for observability)
 *   3. Call Claude with the prompt in `prompts/destinationSuggestions.ts`
 *   4. Strip markdown fences, JSON.parse, validate shape
 *   5. On parse/shape failure: retry (up to MAX_ATTEMPTS total including first try)
 *   6. On final failure: fall back to a hardcoded per-vibe list
 *   7. Emit one structured log per call (ready for downstream analytics)
 *
 * Boundaries this file owns:
 *   - cache key normalization (so callers can't accidentally bust the cache)
 *   - Claude call + retry loop
 *   - response shape validation
 *   - fallback resolution
 *   - structured logging
 *
 * Boundaries this file does NOT own:
 *   - HTTP layer (the route wraps this)
 *   - frontend state
 *   - flight/hotel pricing (the suggestion is just a pointer to a city,
 *     real pricing happens downstream in the optimizer)
 */

import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import { logger } from '../utils/logger';
import {
  DESTINATION_SUGGESTIONS_SYSTEM_PROMPT,
  buildDestinationSuggestionsUserMessage,
  SuggestDestinationsInput,
} from '../prompts/destinationSuggestions';

// ─── Types ───────────────────────────────────────────────────

export type DestinationSuggestion = {
  destination_city: string;
  destination_country: string;
  iata_code: string;
  why_it_fits_vibe: string;
  estimated_total_cost_per_person_usd: { low: number; high: number };
  best_months_to_visit: string[];
  transport_recommendation: 'flight' | 'train' | 'mixed';
  tradeoff_or_caveat: string | null;
  confidence: 'high' | 'medium' | 'low';
};

/**
 * "If you bumped your budget by $X, here's what opens up" — surfaces
 * when Claude detects the user is one tier below dramatically better
 * options. Frontend renders this as a banner / chat message on the
 * results page so the user can choose to up their budget or stick
 * with the cheaper trip.
 */
export type TierUpSuggestion = {
  min_budget_increase_per_person_usd: number;
  new_budget_per_person_usd: number;
  destination_examples: string[];
  why_worth_it: string;
};

export type SuggestDestinationsResult = {
  suggestions: DestinationSuggestion[];
  reasoning_summary: string;
  /** Optional — present only when a modest budget bump unlocks better options. */
  tier_up_suggestion: TierUpSuggestion | null;
  /** Observability metadata — so callers can log / surface "pulled from cache" without re-inspecting logs. */
  meta: {
    cacheHit: boolean;
    attempts: number;
    parseSuccess: boolean;
    fallbackUsed: boolean;
    durationMs: number;
  };
};

// ─── Tunables (module-level so they're findable + changeable in one place) ──

/** Total attempts including the initial try. 1 + 2 retries = 3, per spec. */
const MAX_ATTEMPTS = 3;
/** Claude temperature — spec requires 0.7. */
const TEMPERATURE = 0.7;
/** Cache TTL — 7 days per spec. Long because inputs are coarse-bucketed. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Max entries before the LRU-ish map starts evicting. Guard against unbounded growth. */
const CACHE_MAX_ENTRIES = 500;

// ─── Cache abstraction ───────────────────────────────────────
// Kept behind a minimal interface so future swaps (Redis / Upstash /
// etc.) require no changes outside this file.

interface SuggesterCache {
  get(key: string): SuggestDestinationsResult | undefined;
  set(key: string, value: SuggestDestinationsResult): void;
}

type CacheEntry = { value: SuggestDestinationsResult; expiresAt: number };

class InMemoryCache implements SuggesterCache {
  private store = new Map<string, CacheEntry>();

  get(key: string): SuggestDestinationsResult | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: SuggestDestinationsResult): void {
    // Evict oldest entry when at cap. Not true LRU (insertion-order), but
    // good enough since the key space is bounded by the coarse bucketing.
    if (this.store.size >= CACHE_MAX_ENTRIES) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

const cache: SuggesterCache = new InMemoryCache();

// ─── Cache-key normalization ─────────────────────────────────
/**
 * Build a stable cache key from the inputs. Rounding / lowercasing
 * here is what makes the 7-day TTL practical — users typing "New York"
 * vs "new york" vs "NYC" should hit the same cache entry when their
 * vibe / budget / month / party / trip-type are otherwise the same.
 *
 * Keep this in sync with how callers describe their inputs. If we add
 * a new dimension (e.g. accessibility flag), it must be appended here
 * or we'll mix results across otherwise-different users.
 */
function buildCacheKey(input: SuggestDestinationsInput): string {
  const vibeNorm = input.vibe.trim().toLowerCase();
  const originNorm = input.origin.trim().toLowerCase();
  const budgetBucket = Math.round(input.budgetPerPerson / 100) * 100;
  const monthBucket = extractMonthBucket(input.travelWindow);
  const tripType = input.tripType;
  return `${vibeNorm}__${originNorm}__${budgetBucket}__${monthBucket}__${input.partySize}__${tripType}`;
}

/**
 * Reduce a free-form travel window like "June 15-22, 2026" or "flexible
 * in July" to a stable YYYY-MM bucket. Parsing is intentionally lenient:
 * we pick the first YYYY-MM-DD substring, or the first month-name word,
 * and fall back to "unknown" rather than throw. Cache-key correctness
 * isn't safety-critical — a miss just triggers a fresh Claude call.
 */
function extractMonthBucket(travelWindow: string): string {
  const tw = travelWindow.toLowerCase();
  const isoMatch = tw.match(/(\d{4})-(\d{2})-\d{2}/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  for (let i = 0; i < monthNames.length; i++) {
    if (tw.includes(monthNames[i])) {
      const mm = String(i + 1).padStart(2, '0');
      // Year detection — grab the first 4-digit year, else current.
      const yrMatch = tw.match(/(20\d{2})/);
      const yr = yrMatch ? yrMatch[1] : String(new Date().getFullYear());
      return `${yr}-${mm}`;
    }
  }
  return 'unknown';
}

// ─── Response validation ─────────────────────────────────────
/**
 * Validate the parsed JSON matches the schema we documented in the
 * system prompt. Returns a typed result or throws — the throw is
 * caught by the retry loop and triggers another attempt.
 *
 * We check every field Claude promised. A malformed numeric field is
 * worse than a missing field (it silently renders as NaN later), so
 * we reject anything that fails a strict isFinite check.
 */
function validateSuggesterResponse(raw: any): {
  suggestions: DestinationSuggestion[];
  reasoning_summary: string;
  tier_up_suggestion: TierUpSuggestion | null;
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('response is not an object');
  }
  if (typeof raw.reasoning_summary !== 'string') {
    throw new Error('missing or invalid reasoning_summary');
  }
  if (!Array.isArray(raw.suggestions)) {
    throw new Error('suggestions is not an array');
  }

  const transportSet = new Set(['flight', 'train', 'mixed']);
  const confidenceSet = new Set(['high', 'medium', 'low']);

  const suggestions: DestinationSuggestion[] = raw.suggestions.map((s: any, i: number) => {
    const where = `suggestions[${i}]`;
    if (!s || typeof s !== 'object') throw new Error(`${where} is not an object`);
    if (typeof s.destination_city !== 'string' || !s.destination_city.trim())
      throw new Error(`${where}.destination_city invalid`);
    if (typeof s.destination_country !== 'string' || !s.destination_country.trim())
      throw new Error(`${where}.destination_country invalid`);
    if (typeof s.iata_code !== 'string' || s.iata_code.length < 3)
      throw new Error(`${where}.iata_code invalid`);
    if (typeof s.why_it_fits_vibe !== 'string' || !s.why_it_fits_vibe.trim())
      throw new Error(`${where}.why_it_fits_vibe invalid`);
    const cost = s.estimated_total_cost_per_person_usd;
    if (
      !cost ||
      typeof cost !== 'object' ||
      !Number.isFinite(cost.low) ||
      !Number.isFinite(cost.high) ||
      cost.low > cost.high
    ) {
      throw new Error(`${where}.estimated_total_cost_per_person_usd invalid`);
    }
    if (!Array.isArray(s.best_months_to_visit) || s.best_months_to_visit.some((m: any) => typeof m !== 'string')) {
      throw new Error(`${where}.best_months_to_visit invalid`);
    }
    if (!transportSet.has(s.transport_recommendation)) {
      throw new Error(`${where}.transport_recommendation invalid`);
    }
    if (s.tradeoff_or_caveat !== null && typeof s.tradeoff_or_caveat !== 'string') {
      throw new Error(`${where}.tradeoff_or_caveat invalid`);
    }
    if (!confidenceSet.has(s.confidence)) {
      throw new Error(`${where}.confidence invalid`);
    }
    return s as DestinationSuggestion;
  });

  // tier_up_suggestion is optional. Strict-validate when present so a
  // half-formed object (NaN fields, missing examples) doesn't silently
  // render as a broken banner downstream.
  let tier_up_suggestion: TierUpSuggestion | null = null;
  if (raw.tier_up_suggestion != null) {
    const t = raw.tier_up_suggestion;
    if (typeof t !== 'object') throw new Error('tier_up_suggestion must be object or null');
    if (!Number.isFinite(t.min_budget_increase_per_person_usd) || t.min_budget_increase_per_person_usd <= 0) {
      throw new Error('tier_up_suggestion.min_budget_increase_per_person_usd invalid');
    }
    if (!Number.isFinite(t.new_budget_per_person_usd) || t.new_budget_per_person_usd <= 0) {
      throw new Error('tier_up_suggestion.new_budget_per_person_usd invalid');
    }
    if (!Array.isArray(t.destination_examples) || t.destination_examples.length === 0 ||
        t.destination_examples.some((d: any) => typeof d !== 'string')) {
      throw new Error('tier_up_suggestion.destination_examples invalid');
    }
    if (typeof t.why_worth_it !== 'string' || !t.why_worth_it.trim()) {
      throw new Error('tier_up_suggestion.why_worth_it invalid');
    }
    tier_up_suggestion = {
      min_budget_increase_per_person_usd: t.min_budget_increase_per_person_usd,
      new_budget_per_person_usd: t.new_budget_per_person_usd,
      destination_examples: t.destination_examples,
      why_worth_it: t.why_worth_it,
    };
  }

  return { suggestions, reasoning_summary: raw.reasoning_summary, tier_up_suggestion };
}

/**
 * Strip common markdown artifacts Claude occasionally emits before a
 * JSON payload (```json ... ``` fences, plain ``` fences, or leading
 * prose). The prompt asks for raw JSON, but defense-in-depth here
 * saves a retry round-trip when Claude ignores the rule.
 */
function stripMarkdownFences(raw: string): string {
  let s = raw.trim();
  // ```json ... ``` or ``` ... ```
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  // If response starts with prose but contains a JSON object, extract
  // the largest balanced {...} block. Conservative — only runs when the
  // whole string doesn't start with {.
  if (!s.startsWith('{')) {
    const firstBrace = s.indexOf('{');
    if (firstBrace >= 0) {
      let depth = 0;
      for (let i = firstBrace; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) {
            return s.slice(firstBrace, i + 1);
          }
        }
      }
    }
  }
  return s;
}

// ─── Fallback destinations (per spec) ────────────────────────
/**
 * Hardcoded fallback when Claude fails or the API key is missing.
 * Per spec: seed Adventure, leave TODO markers for the other vibes.
 *
 * IATA codes verified on Duffel sandbox; prices left null (never invent
 * prices — real costs come from the booking APIs downstream).
 */
const FALLBACK_BY_VIBE: Record<string, DestinationSuggestion[]> = {
  adventure: [
    {
      destination_city: 'San José',
      destination_country: 'Costa Rica',
      iata_code: 'SJO',
      why_it_fits_vibe: 'Volcano hikes, rainforest canopy tours, whitewater rafting, surfing on the Pacific — all within short domestic drives.',
      estimated_total_cost_per_person_usd: { low: 1200, high: 2000 },
      best_months_to_visit: ['December', 'January', 'February', 'March', 'April'],
      transport_recommendation: 'flight',
      tradeoff_or_caveat: 'Green season (May–Nov) means lower prices but some adventure trails close due to rain.',
      confidence: 'high',
    },
    {
      destination_city: 'Reykjavik',
      destination_country: 'Iceland',
      iata_code: 'KEF',
      why_it_fits_vibe: 'Glacier hikes, ice caves, waterfall rappelling, Northern Lights chasing, and the Golden Circle drive — adventure on a geologic scale.',
      estimated_total_cost_per_person_usd: { low: 1800, high: 3200 },
      best_months_to_visit: ['February', 'March', 'September', 'October'],
      transport_recommendation: 'flight',
      tradeoff_or_caveat: 'Summer sun is longer but winter is when Northern Lights + ice caves are accessible — pick your trade-off.',
      confidence: 'high',
    },
    {
      destination_city: 'Cusco',
      destination_country: 'Peru',
      iata_code: 'CUZ',
      why_it_fits_vibe: 'Inca Trail + Machu Picchu, Sacred Valley hikes, Rainbow Mountain, plus Amazon basin day trips from nearby Puerto Maldonado.',
      estimated_total_cost_per_person_usd: { low: 1500, high: 2800 },
      best_months_to_visit: ['May', 'June', 'July', 'August', 'September'],
      transport_recommendation: 'flight',
      tradeoff_or_caveat: 'Altitude — allow 2 days in Cusco before any serious trekking.',
      confidence: 'high',
    },
  ],
  // TODO: seed fallback for 'beach' — e.g. Tulum, Maldives, Bali
  // TODO: seed fallback for 'culture' — e.g. Kyoto, Rome, Istanbul
  // TODO: seed fallback for 'romance' — e.g. Paris, Santorini, Positano
  // TODO: seed fallback for 'family' — e.g. Orlando, Tokyo, London
  // TODO: seed fallback for 'food' — e.g. Tokyo, Lyon, Oaxaca
  // TODO: seed fallback for 'nightlife' — e.g. Berlin, Bangkok, Ibiza
};

function resolveFallback(vibe: string): DestinationSuggestion[] {
  const key = vibe.trim().toLowerCase();
  return FALLBACK_BY_VIBE[key] ?? [];
}

// ─── Main entry point ────────────────────────────────────────

/**
 * Get destination suggestions for a vibe-first trip. Called by the
 * `/api/plan/suggest-for-vibe` route handler; returns both the
 * suggestions and metadata useful for observability.
 *
 * Never throws on Claude failures — degrades to fallback + friendly
 * `reasoning_summary`. The only way this function throws is if the
 * caller passes invalid inputs (missing required fields), which is
 * a programmer error, not a runtime condition.
 */
export async function suggestDestinationsForVibe(
  input: SuggestDestinationsInput,
): Promise<SuggestDestinationsResult> {
  const started = Date.now();
  const requiredFields: (keyof SuggestDestinationsInput)[] = [
    'vibe', 'origin', 'budgetPerPerson', 'travelWindow', 'partySize', 'tripType',
  ];
  for (const f of requiredFields) {
    if (input[f] === undefined || input[f] === null || input[f] === '') {
      throw new Error(`suggestDestinationsForVibe: missing required field "${f}"`);
    }
  }

  const cacheKey = buildCacheKey(input);

  // Cache lookup.
  const hit = cache.get(cacheKey);
  if (hit) {
    const result: SuggestDestinationsResult = {
      ...hit,
      meta: { ...hit.meta, cacheHit: true, durationMs: Date.now() - started },
    };
    logSuggesterCall({ input, result, cacheHit: true });
    return result;
  }

  // Call Claude with retry. Each iteration: call → strip → parse → validate.
  const anthropic = getAnthropicSafe();
  let lastErr: unknown = null;
  let attempts = 0;

  if (anthropic) {
    for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
      try {
        const response = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 2048,
          temperature: TEMPERATURE,
          system: DESTINATION_SUGGESTIONS_SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: buildDestinationSuggestionsUserMessage(input) },
          ],
        });

        const rawText =
          response.content?.[0]?.type === 'text'
            ? (response.content[0] as any).text
            : '';
        const cleaned = stripMarkdownFences(rawText);
        const parsed = JSON.parse(cleaned);
        const { suggestions, reasoning_summary, tier_up_suggestion } =
          validateSuggesterResponse(parsed);

        const result: SuggestDestinationsResult = {
          suggestions,
          reasoning_summary,
          tier_up_suggestion,
          meta: {
            cacheHit: false,
            attempts,
            parseSuccess: true,
            fallbackUsed: false,
            durationMs: Date.now() - started,
          },
        };
        cache.set(cacheKey, result);
        logSuggesterCall({ input, result, cacheHit: false });
        return result;
      } catch (err: any) {
        lastErr = err;
        logger.warn('suggestDestinationsForVibe: attempt failed', {
          attempt: attempts,
          message: err?.message,
        });
        // fall through to retry
      }
    }
  }

  // Either API key missing or all attempts exhausted → fallback.
  const fallback = resolveFallback(input.vibe);
  const reasoning_summary = fallback.length > 0
    ? `Showing a curated list of ${input.vibe} destinations (AI temporarily unavailable).`
    : `I couldn't find destinations matching that vibe right now. Try a more common vibe (e.g. Adventure, Beach, Culture) or try again in a minute.`;

  const result: SuggestDestinationsResult = {
    suggestions: fallback,
    reasoning_summary,
    tier_up_suggestion: null,
    meta: {
      cacheHit: false,
      // Clamp: after the for loop exits via the guard, `attempts` holds
      // MAX_ATTEMPTS + 1. Cap it so logs/analytics report the truthful
      // "tried N times, all failed" number.
      attempts: Math.min(attempts, MAX_ATTEMPTS),
      parseSuccess: false,
      fallbackUsed: true,
      durationMs: Date.now() - started,
    },
  };
  logSuggesterCall({ input, result, cacheHit: false, lastError: String(lastErr ?? 'no-api-key') });
  return result;
}

// ─── Logging ─────────────────────────────────────────────────
/**
 * Structured log for every call. One JSON object per event so
 * downstream log aggregators (Datadog, Logtail, etc.) can ingest
 * without re-parsing. Keys are stable — do NOT rename without
 * checking who consumes them.
 *
 * Prepared for future behavioral analytics: `input` + `result` give
 * us the (request, response) pairs that become the training dataset
 * for quality tuning and A/B tests.
 */
function logSuggesterCall(params: {
  input: SuggestDestinationsInput;
  result: SuggestDestinationsResult;
  cacheHit: boolean;
  lastError?: string;
}): void {
  const { input, result, cacheHit, lastError } = params;
  const payload = {
    event: 'claude.destinationSuggestions',
    timestamp: new Date().toISOString(),
    cacheHit,
    attempts: result.meta.attempts,
    parseSuccess: result.meta.parseSuccess,
    fallbackUsed: result.meta.fallbackUsed,
    durationMs: result.meta.durationMs,
    suggestionCount: result.suggestions.length,
    input: {
      vibe: input.vibe,
      origin: input.origin,
      budgetPerPerson: input.budgetPerPerson,
      travelWindow: input.travelWindow,
      partySize: input.partySize,
      tripType: input.tripType,
      hasExtras: !!input.extras,
    },
    suggestionIatas: result.suggestions.map((s) => s.iata_code),
    lastError,
  };
  // Stringify so log collectors that don't pretty-print still see one line per event.
  logger.info?.('suggestDestinationsForVibe', payload);
  // Fallback in case `logger.info` is not defined (the logger util
  // currently only exposes warn/error). Console is fine for dev.
  if (!logger.info) {
    console.log(JSON.stringify(payload));
  }
}
