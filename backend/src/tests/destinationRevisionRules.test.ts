/**
 * Offline fallback for /api/plan/revise-destinations: when Claude is
 * unreachable, the common destination fixes are still understood, and
 * everything else keeps the 503 so the planner falls through as before.
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
import { getAnthropicSafe } from '../services/anthropic';
import { matchListed, ruleBasedRevision } from '../services/destinationRevisionRules';

const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
app.use(errorHandler);
const post = (message: string, destinations: string[]) =>
  request(app)
    .post('/api/plan/revise-destinations')
    .send({ message, destinations, currentQuestion: 'Where are you starting from?' });

beforeEach(() => {
  jest.clearAllMocks();
  (getAnthropicSafe as jest.Mock).mockReturnValue(null); // offline by default here
});

describe('matchListed', () => {
  it('finds the listed name through case, accents and small typos', () => {
    expect(matchListed(['Rome', 'Florence'], 'florance')).toBe('Florence');
    expect(matchListed(['São Paulo'], 'sao paulo')).toBe('São Paulo');
  });
  it('does not stretch short names', () => {
    expect(matchListed(['Nice'], 'Rice')).toBeNull();
    expect(matchListed(['Rome'], 'Paris')).toBeNull();
  });
});

describe('ruleBasedRevision', () => {
  const many = ['Rome', 'Florence', 'Milan'];
  it.each([
    ['actually Florence not Milan', many, [{ name: 'replace_destination', input: { old: 'Milan', new: 'Florence' } }]],
    ['swap florance for Bologna', many, [{ name: 'replace_destination', input: { old: 'Florence', new: 'Bologna' } }]],
    ['Bologna instead of Florence', many, [{ name: 'replace_destination', input: { old: 'Florence', new: 'Bologna' } }]],
    ['oh wait, drop Milan please', many, [{ name: 'remove_destination', input: { city: 'Milan' } }]],
    ['add Naples after Rome', many, [{ name: 'add_destination', input: { city: 'Naples', afterCity: 'Rome' } }]],
    ['add Naples before Milan', many, [{ name: 'add_destination', input: { city: 'Naples', beforeCity: 'Milan' } }]],
  ])('%s', (msg, list, expected) => {
    expect(ruleBasedRevision(msg, list)).toEqual(expected);
  });

  it('"Venice not Venezuela" replaces the only city even when it came from a country pick', () => {
    expect(ruleBasedRevision('actually Venice not Venezuela', ['Caracas'])).toEqual([
      { name: 'replace_destination', input: { old: 'Caracas', new: 'Venice' } },
    ]);
  });

  it.each([
    ['Boston', ['Rome']],
    ['3 not 2', ['Rome']], // a travellers answer, not a city
    ['not sure yet', ['Rome']],
    ['I want to avoid long layovers, not red-eyes', ['Rome', 'Milan']],
    ['remove Paris', ['Rome', 'Milan']], // not on the trip
    ['add Spain', ['Rome']], // a country: left to the AI / the step
    ['Nice not Paris', ['Rome', 'Milan']], // several cities, neither named: ambiguous
  ])('leaves a normal answer alone: %s', (msg, list) => {
    expect(ruleBasedRevision(msg, list)).toBeNull();
  });
});

describe('POST /api/plan/revise-destinations without Claude', () => {
  it('no API key: a recognised fix is applied, not turned into the step answer', async () => {
    const res = await post('actually Venice not Venezuela', ['Caracas']);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'revision', destinations: ['Venice'] });
    expect(res.body.reply).toMatch(/Venice instead of Caracas/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('AI call fails: same fallback', async () => {
    (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));
    const res = await post('drop Milan', ['Rome', 'Milan']);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'revision', destinations: ['Rome'] });
  });

  it('malformed AI output: same fallback', async () => {
    (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    const res = await post('swap Milan for Bologna', ['Rome', 'Milan']);
    expect(res.body).toMatchObject({ type: 'revision', destinations: ['Rome', 'Bologna'] });
  });

  it('a plain step answer still 503s, so the planner hands it to the question as before', async () => {
    const res = await post('Boston', ['Rome']);
    expect(res.status).toBe(503);
  });

  it('a rule that cannot apply answers instead of failing', async () => {
    const res = await post('drop Rome', ['Rome']); // the only city
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'answer', aboutDestinations: true });
    expect(res.body.reply).toMatch(/only destination/);
  });

  it('with Claude up, the rules are never consulted', async () => {
    (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't0', name: 'answer_only', input: { answer: '', aboutDestinations: false } }],
    });
    const res = await post('drop Milan', ['Rome', 'Milan']);
    expect(res.body).toMatchObject({ type: 'answer', aboutDestinations: false });
  });
});
