/**
 * POST /api/plan/suggest-for-vibe takes a skipped budget as "no limit"
 * (budgetPerPerson: null). The owner's call, 2026-11-28: on the vibe path,
 * Skip on the budget question means no limit, not a dead end.
 *
 * The model is mocked; the route, the prompt and the suggester are real.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    ANTHROPIC_API_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
    CORS_ORIGIN: 'http://localhost:3000',
    FRONTEND_URL: 'http://localhost:3000',
    API_PUBLIC_URL: 'http://localhost:4000',
    EMAIL_FROM: 'test <test@example.com>',
    LOCATION_RESOLVER_MODE: 'shadow',
    PORT: 4000,
  },
}));

const mockCreate = jest.fn();
jest.mock('../services/anthropic', () => ({
  getAnthropicSafe: jest.fn(() => ({ messages: { create: mockCreate } })),
  getAnthropic: jest.fn(),
  DEFAULT_MODEL: 'claude-test',
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';

const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
app.use(errorHandler);

const body = (budgetPerPerson: unknown) => ({
  vibe: 'Culture (no-limit route test)',
  origin: 'Boston',
  budgetPerPerson,
  travelWindow: 'flexible',
  partySize: 2,
  tripType: 'round-trip',
});

const reply = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        suggestions: [
          {
            destination_city: 'Vienna',
            destination_country: 'Austria',
            iata_code: 'VIE',
            why_it_fits_vibe: 'Opera, museums and coffee houses.',
            estimated_total_cost_per_person_usd: { low: 1400, high: 2200 },
            best_months_to_visit: ['May', 'September'],
            transport_recommendation: 'flight',
            tradeoff_or_caveat: null,
            confidence: 'high',
          },
        ],
        reasoning_summary: 'Vienna is a culture capital.',
        tier_up_suggestion: null,
      }),
    },
  ],
};

beforeEach(() => jest.clearAllMocks());

describe('POST /api/plan/suggest-for-vibe with a skipped budget', () => {
  it('null is accepted as no limit, and the model is told so', async () => {
    mockCreate.mockResolvedValueOnce(reply);
    const res = await request(app).post('/api/plan/suggest-for-vibe').send(body(null));
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].destination_city).toBe('Vienna');
    expect(JSON.stringify(mockCreate.mock.calls[0][0].messages)).toContain('Budget per person: no limit');
  });

  it('a budget still has to be a positive number when given', async () => {
    const res = await request(app).post('/api/plan/suggest-for-vibe').send(body(0));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
