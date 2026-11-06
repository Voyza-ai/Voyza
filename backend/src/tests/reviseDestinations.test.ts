/**
 * Planning-phase destination revision — service + route.
 * Anthropic is mocked: we test the op mapping, the deterministic list
 * maths and the rule-based fallback, not the model.
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
const mockGetSafe = jest.fn(() => ({ messages: { create: mockCreate } }) as any);
jest.mock('../services/anthropic', () => ({
  getAnthropicSafe: () => mockGetSafe(),
  getAnthropic: jest.fn(),
  DEFAULT_MODEL: 'claude-test',
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import {
  applyRevisionOps,
  findDestination,
  mightBeRevision,
  reviseDestinations,
  ruleBasedOps,
} from '../services/reviseDestinations';

const tools = (...uses: Array<[string, any]>) => ({
  content: uses.map(([name, input]) => ({ type: 'tool_use', name, input })),
});

beforeEach(() => {
  mockCreate.mockReset();
  mockGetSafe.mockImplementation(() => ({ messages: { create: mockCreate } }));
});

describe('findDestination', () => {
  const list = ['Rome', 'Florence', 'São Paulo'];
  it('matches case, accents and small typos', () => {
    expect(findDestination(list, 'rome')).toBe(0);
    expect(findDestination(list, 'florance')).toBe(1);
    expect(findDestination(list, 'Sao Paulo')).toBe(2);
    expect(findDestination(['Rome, Italy'], 'Rome')).toBe(0);
  });
  it('does not match unrelated cities', () => {
    expect(findDestination(list, 'Paris')).toBe(-1);
    expect(findDestination(['Nice'], 'Rice')).toBe(-1); // short names must match exactly
  });
});

describe('applyRevisionOps', () => {
  it('replaces in place, keeping order', () => {
    const r = applyRevisionOps(['Rome', 'Florence', 'Milan'], [{ op: 'replace', from: 'Florence', to: 'Bologna' }]);
    expect(r.destinations).toEqual(['Rome', 'Bologna', 'Milan']);
    expect(r.changes).toEqual([{ type: 'replaced', from: 'Florence', to: 'Bologna' }]);
  });
  it('replacing an unknown city on a one-city trip swaps the only city', () => {
    const r = applyRevisionOps(['Venezuela'], [{ op: 'replace', from: 'Venezula', to: 'Venice' }]);
    expect(r.destinations).toEqual(['Venice']);
  });
  it('replacing an unknown city on a multi-city trip is refused, not guessed', () => {
    const r = applyRevisionOps(['Rome', 'Milan'], [{ op: 'replace', from: 'Paris', to: 'Nice' }]);
    expect(r.destinations).toEqual(['Rome', 'Milan']);
    expect(r.changes).toHaveLength(0);
    expect(r.problems[0]).toMatch(/Paris isn't on the trip/);
  });
  it('never removes the last city', () => {
    const r = applyRevisionOps(['Rome'], [{ op: 'remove', city: 'Rome' }]);
    expect(r.destinations).toEqual(['Rome']);
    expect(r.problems[0]).toMatch(/at least one city/);
  });
  it('adds after a named city, skips duplicates, caps at 5', () => {
    expect(applyRevisionOps(['Lyon', 'Paris'], [{ op: 'add', city: 'Nice', after: 'Lyon' }]).destinations)
      .toEqual(['Lyon', 'Nice', 'Paris']);
    expect(applyRevisionOps(['Rome'], [{ op: 'add', city: 'rome' }]).changes).toHaveLength(0);
    const full = ['A1', 'B2', 'C3', 'D4', 'E5'];
    expect(applyRevisionOps(full, [{ op: 'add', city: 'Oslo' }]).destinations).toEqual(full);
  });
  it('replace into a city already on the trip collapses the duplicate', () => {
    const r = applyRevisionOps(['Rome', 'Florence', 'Milan'], [{ op: 'replace', from: 'Florence', to: 'Milan' }]);
    expect(r.destinations).toEqual(['Rome', 'Milan']);
  });
  it('applies several ops in order', () => {
    const r = applyRevisionOps(
      ['Paris', 'Lyon'],
      [{ op: 'remove', city: 'Lyon' }, { op: 'add', city: 'Nice' }],
    );
    expect(r.destinations).toEqual(['Paris', 'Nice']);
  });
});

describe('ruleBasedOps', () => {
  const one = ['Venezuela'];
  const many = ['Rome', 'Florence', 'Milan'];
  it.each([
    ['actually Venice not Venezuela', one, [{ op: 'replace', from: 'Venezuela', to: 'Venice' }]],
    ['Venice, not Venezuela', one, [{ op: 'replace', from: 'Venezuela', to: 'Venice' }]],
    ['swap Florence for Bologna', many, [{ op: 'replace', from: 'Florence', to: 'Bologna' }]],
    ['replace florence with bologna', many, [{ op: 'replace', from: 'florence', to: 'bologna' }]],
    ['Bologna instead of Florence', many, [{ op: 'replace', from: 'Florence', to: 'Bologna' }]],
    ['drop Milan', many, [{ op: 'remove', city: 'Milan' }]],
    ['oh wait, remove Milan please', many, [{ op: 'remove', city: 'Milan' }]],
    ['add Naples', many, [{ op: 'add', city: 'Naples' }]],
    ['also add Naples after Rome', many, [{ op: 'add', city: 'Naples', after: 'Rome' }]],
  ])('%s', (msg, list, expected) => {
    expect(ruleBasedOps(msg, list)).toEqual(expected);
  });
  it.each([
    ['New York', many],
    ['not sure yet', many],
    ['I want to avoid long layovers, not red-eyes', many],
    ['remove Paris', many], // not on the trip
  ])('leaves a normal answer alone: %s', (msg, list) => {
    expect(ruleBasedOps(msg, list)).toBeNull();
  });
});

describe('mightBeRevision', () => {
  it('skips plain answers without a model call', () => {
    expect(mightBeRevision('New York', ['Rome'])).toBe(false);
    expect(mightBeRevision('4 people', ['Rome'])).toBe(false);
  });
  it('flags cue words or a trip city', () => {
    expect(mightBeRevision('actually Venice', ['Rome'])).toBe(true);
    expect(mightBeRevision('Rome feels too long', ['Rome'])).toBe(true);
  });
});

describe('reviseDestinations (AI path)', () => {
  it('maps a replace tool call and computes the list itself', async () => {
    mockCreate.mockResolvedValue(tools(['replace_destination', { from: 'Venezuela', to: 'Venice' }]));
    const r = await reviseDestinations({ message: 'actually Venice not Venezuela', destinations: ['Venezuela'] });
    expect(r).toMatchObject({ kind: 'revised', destinations: ['Venice'], source: 'ai' });
    expect(r.reply).toMatch(/swapped Venezuela for Venice/);
    // The current question and list reach the model.
    expect(mockCreate.mock.calls[0][0].system).toContain('["Venezuela"]');
    expect(mockCreate.mock.calls[0][0].tool_choice).toEqual({ type: 'any' });
  });
  it('handles several tool calls in one message', async () => {
    mockCreate.mockResolvedValue(
      tools(['remove_destination', { city: 'Lyon' }], ['add_destination', { city: 'Nice', after: 'Paris' }]),
    );
    const r = await reviseDestinations({ message: 'drop Lyon and add Nice', destinations: ['Paris', 'Lyon'] });
    expect(r.destinations).toEqual(['Paris', 'Nice']);
  });
  it('not_a_revision passes the message through untouched', async () => {
    mockCreate.mockResolvedValue(tools(['not_a_revision', {}]));
    const r = await reviseDestinations({
      message: "I'd rather not take red-eyes",
      destinations: ['Rome'],
      currentQuestion: 'Anything else I should know?',
    });
    expect(r).toMatchObject({ kind: 'none', destinations: ['Rome'] });
  });
  it('answer_only returns the reply and keeps the list', async () => {
    mockCreate.mockResolvedValue(tools(['answer_only', { reply: 'Which city in Japan?' }]));
    const r = await reviseDestinations({ message: 'actually make it Japan', destinations: ['Rome'] });
    expect(r).toMatchObject({ kind: 'answer', destinations: ['Rome'], reply: 'Which city in Japan?' });
  });
  it('an op that cannot apply comes back as an answer, not a silent no-op', async () => {
    mockCreate.mockResolvedValue(tools(['remove_destination', { city: 'Rome' }]));
    const r = await reviseDestinations({ message: 'remove Rome', destinations: ['Rome'] });
    expect(r.kind).toBe('answer');
    expect(r.reply).toMatch(/at least one city/);
  });
  it('plain answers never call the model', async () => {
    const r = await reviseDestinations({ message: 'New York', destinations: ['Rome'] });
    expect(r.kind).toBe('none');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('reviseDestinations (fallback)', () => {
  it('uses rules when the AI call throws', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    const r = await reviseDestinations({ message: 'swap Florence for Bologna', destinations: ['Rome', 'Florence'] });
    expect(r).toMatchObject({ kind: 'revised', destinations: ['Rome', 'Bologna'], source: 'rules' });
  });
  it('uses rules when there is no API key', async () => {
    mockGetSafe.mockImplementation(() => null as any);
    const r = await reviseDestinations({ message: 'actually Venice not Venezuela', destinations: ['Venezuela'] });
    expect(r).toMatchObject({ kind: 'revised', destinations: ['Venice'], source: 'rules' });
  });
  it('malformed tool output falls back to rules', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });
    const r = await reviseDestinations({ message: 'drop Milan', destinations: ['Rome', 'Milan'] });
    expect(r).toMatchObject({ kind: 'revised', destinations: ['Rome'], source: 'rules' });
  });
  it('unrecognised phrasing without AI is "none", so the step answer is kept', async () => {
    mockGetSafe.mockImplementation(() => null as any);
    const r = await reviseDestinations({ message: 'not sure, maybe 3 of us', destinations: ['Rome'] });
    expect(r.kind).toBe('none');
  });
});

describe('POST /api/plan/revise-destinations', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);

  it('returns the revision', async () => {
    mockCreate.mockResolvedValue(tools(['replace_destination', { from: 'Venezuela', to: 'Venice' }]));
    const res = await request(app)
      .post('/api/plan/revise-destinations')
      .send({ message: 'actually Venice not Venezuela', destinations: ['Venezuela'], currentQuestion: 'Where are you starting from?' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'revised', destinations: ['Venice'] });
  });
  it('400s on an empty list or too many cities', async () => {
    expect((await request(app).post('/api/plan/revise-destinations').send({ message: 'x', destinations: [] })).status).toBe(400);
    expect(
      (await request(app).post('/api/plan/revise-destinations').send({ message: 'x', destinations: ['a', 'b', 'c', 'd', 'e', 'f'] })).status,
    ).toBe(400);
  });
});
