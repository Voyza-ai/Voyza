// Mock environment before any imports. The suggester's own import graph
// doesn't reach config/env today (the Anthropic client is stubbed below), but
// keep the mock so a future env-reading import can't halt the suite via
// env.ts's process.exit(1) on missing vars.
jest.mock('../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test_anthropic_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

// Stub the Anthropic client. Same `__mock` escape hatch as flights.test.ts:
// the jest.fn has to be created INSIDE the factory, because jest hoists
// jest.mock() above this file's own const declarations.
jest.mock('../services/anthropic', () => {
  const create = jest.fn();
  return {
    getAnthropicSafe: () => ({ messages: { create } }),
    DEFAULT_MODEL: 'claude-test-model',
    __mockCreate: create,
  };
});

import { APIError } from '@anthropic-ai/sdk';
import { suggestDestinationsForVibe } from '../services/destinationSuggester';
import { SuggestDestinationsInput } from '../prompts/destinationSuggestions';

const { __mockCreate: mockCreate } = require('../services/anthropic');

/** A well-formed Claude reply, so validateSuggesterResponse accepts it. */
function claudeReply(city: string) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          suggestions: [
            {
              destination_city: city,
              destination_country: 'Portugal',
              iata_code: 'LIS',
              why_it_fits_vibe: 'Atlantic coastline, tiled streets, cheap pastries.',
              estimated_total_cost_per_person_usd: { low: 900, high: 1400 },
              best_months_to_visit: ['May', 'June'],
              transport_recommendation: 'flight',
              tradeoff_or_caveat: null,
              confidence: 'high',
            },
          ],
          reasoning_summary: `Picked ${city}.`,
          tier_up_suggestion: null,
        }),
      },
    ],
  };
}

// The suggester's cache is module-level and intentionally not resettable from
// outside, so every test below uses its own `vibe`. That keeps cache keys from
// colliding across tests without reaching into the module's internals.
const baseInput: SuggestDestinationsInput = {
  vibe: 'beach',
  origin: 'New York',
  budgetPerPerson: 1500,
  travelWindow: '2026-06-15',
  partySize: 2,
  tripType: 'round-trip',
};

describe('suggestDestinationsForVibe cache key', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("treats extras as part of the key, so one user's notes never answer another's request", async () => {
    mockCreate
      .mockResolvedValueOnce(claudeReply('Lisbon'))
      .mockResolvedValueOnce(claudeReply('Faro'));

    const withExtras = await suggestDestinationsForVibe({
      ...baseInput,
      vibe: 'beach-extras',
      extras: 'step-free access needed, no long layovers',
    });
    const withoutExtras = await suggestDestinationsForVibe({
      ...baseInput,
      vibe: 'beach-extras',
    });

    // Before the fix this was 1 call, and `withoutExtras` was served the
    // suggestions AND reasoning_summary generated from the other user's notes.
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(withExtras.suggestions[0].destination_city).toBe('Lisbon');
    expect(withoutExtras.meta.cacheHit).toBe(false);
    expect(withoutExtras.suggestions[0].destination_city).toBe('Faro');
  });

  it('normalizes case and whitespace in extras so trivial rewordings share an entry', async () => {
    mockCreate.mockResolvedValue(claudeReply('Porto'));

    const first = await suggestDestinationsForVibe({
      ...baseInput,
      vibe: 'beach-normalize',
      extras: 'No Long Layovers',
    });
    const second = await suggestDestinationsForVibe({
      ...baseInput,
      vibe: 'beach-normalize',
      extras: '  no   long layovers  ',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(first.meta.cacheHit).toBe(false);
    expect(second.meta.cacheHit).toBe(true);
    expect(second.suggestions[0].destination_city).toBe('Porto');
  });
});

describe('suggestDestinationsForVibe retry policy', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('does not retry an Anthropic APIError', async () => {
    // A 401 fails identically every time, and the SDK already retries the
    // retryable statuses twice on its own.
    mockCreate.mockRejectedValue(new APIError(401, undefined, 'invalid x-api-key', undefined));

    const result = await suggestDestinationsForVibe({ ...baseInput, vibe: 'adventure' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.meta.attempts).toBe(1);
    expect(result.meta.fallbackUsed).toBe(true);
    // 'adventure' is the one seeded fallback vibe.
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('still retries a malformed response, up to MAX_ATTEMPTS', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'sorry, no JSON today' }] });

    const result = await suggestDestinationsForVibe({ ...baseInput, vibe: 'culture' });

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(result.meta.attempts).toBe(3);
    expect(result.meta.parseSuccess).toBe(false);
    expect(result.meta.fallbackUsed).toBe(true);
  });

  it('caches the outage fallback so the next request does not re-call Claude', async () => {
    mockCreate.mockRejectedValue(new APIError(529, undefined, 'overloaded', undefined));

    const first = await suggestDestinationsForVibe({ ...baseInput, vibe: 'nightlife' });
    const second = await suggestDestinationsForVibe({ ...baseInput, vibe: 'nightlife' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(first.meta.cacheHit).toBe(false);
    expect(second.meta.cacheHit).toBe(true);
    expect(second.meta.fallbackUsed).toBe(true);
  });
});
