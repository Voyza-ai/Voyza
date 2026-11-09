/**
 * POST /api/plan/revise-destinations — planning-phase destination edits.
 *
 * The model is scripted; the list edits, the city check and the reply are
 * real. The contract under test: only the destination list comes back, so
 * the client's other answers (dates, budget, vibe) can't be touched.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    ANTHROPIC_API_KEY: 'test_key',
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
import { applyDestinationOps, REVISION_TOOLS } from '../services/destinationRevision';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);
  return app;
}

const tools = (...calls: Array<[string, any]>) => ({
  content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })),
});

async function revise(app: express.Express, destinations: string[], ...calls: Array<[string, any]>) {
  mockCreate.mockResolvedValueOnce(tools(...calls));
  return request(app)
    .post('/api/plan/revise-destinations')
    .send({ message: 'actually Venice not Venezuela', destinations, currentQuestion: 'When are you thinking?' });
}

beforeEach(() => {
  jest.clearAllMocks();
  (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
});

describe('POST /api/plan/revise-destinations', () => {
  const app = createApp();

  it('declares exactly the four tools and forces a tool call', async () => {
    expect(REVISION_TOOLS.map((t) => t.name)).toEqual([
      'add_destination', 'remove_destination', 'replace_destination', 'answer_only',
    ]);
    await revise(app, ['Caracas'], ['replace_destination', { old: 'Caracas', new: 'Venice' }]);
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: 'any' });
    expect(sent.system).toContain('["Caracas"]');
    expect(sent.system).toContain('When are you thinking?');
  });

  it('replace_destination fixes the typo and returns only the list', async () => {
    const res = await revise(app, ['Caracas', 'Rome'], ['replace_destination', { old: 'Caracas', new: 'Venice' }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: 'revision',
      destinations: ['Venice', 'Rome'],
      changes: [{ kind: 'replace', from: 'Caracas', to: 'Venice' }],
      reply: "Got it — Venice instead of Caracas. You're going to Venice and Rome.",
    });
  });

  it('add_destination inserts after the named city', async () => {
    const res = await revise(app, ['Rome', 'Venice'], ['add_destination', { city: 'Florence', afterCity: 'Rome' }]);
    expect(res.body.destinations).toEqual(['Rome', 'Florence', 'Venice']);
    expect(res.body.changes).toEqual([{ kind: 'add', city: 'Florence', afterCity: 'Rome' }]);
  });

  it('add_destination before the first city puts it first', async () => {
    const res = await revise(app, ['Rome', 'Venice'], ['add_destination', { city: 'Naples', beforeCity: 'rome' }]);
    expect(res.body.destinations).toEqual(['Naples', 'Rome', 'Venice']);
    expect(res.body.changes).toEqual([{ kind: 'add', city: 'Naples', beforeCity: 'Rome' }]);
    expect(res.body.reply).toMatch(/Naples added before Rome/);
  });

  it('add_destination before a middle city', async () => {
    const res = await revise(app, ['Rome', 'Venice'], ['add_destination', { city: 'Florence', beforeCity: 'Venice' }]);
    expect(res.body.destinations).toEqual(['Rome', 'Florence', 'Venice']);
  });

  it('add_destination without afterCity appends', async () => {
    const res = await revise(app, ['Rome'], ['add_destination', { city: 'Naples' }]);
    expect(res.body.destinations).toEqual(['Rome', 'Naples']);
  });

  it('remove_destination drops the city (case-insensitive)', async () => {
    const res = await revise(app, ['Rome', 'Milan'], ['remove_destination', { city: 'milan' }]);
    expect(res.body.type).toBe('revision');
    expect(res.body.destinations).toEqual(['Rome']);
  });

  it('applies several tool calls in order', async () => {
    const res = await revise(
      app,
      ['Caracas'],
      ['replace_destination', { old: 'Caracas', new: 'Venice' }],
      ['add_destination', { city: 'Rome' }],
    );
    expect(res.body.destinations).toEqual(['Venice', 'Rome']);
    expect(res.body.reply).toBe("Got it — Venice instead of Caracas, Rome added. You're going to Venice and Rome.");
  });

  it('removing the only destination is refused and the list is unchanged', async () => {
    const res = await revise(app, ['Rome'], ['remove_destination', { city: 'Rome' }]);
    expect(res.body.type).toBe('answer');
    expect(res.body.aboutDestinations).toBe(true);
    expect(res.body.reply).toMatch(/only destination/);
    expect(res.body.destinations).toBeUndefined();
  });

  it('replacing with a country is refused with a question', async () => {
    const res = await revise(app, ['Rome'], ['replace_destination', { old: 'Rome', new: 'Venezuela' }]);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toMatch(/country/);
  });

  it('a city that is not on the list is refused', async () => {
    const res = await revise(app, ['Rome'], ['replace_destination', { old: 'Paris', new: 'Lyon' }]);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toMatch(/Paris isn't on your list/);
  });

  it('one good edit and one refused edit: applies the good one and says what was refused', async () => {
    const res = await revise(
      app,
      ['Rome'],
      ['add_destination', { city: 'Florence' }],
      ['add_destination', { city: 'Barcelonaa' }],
    );
    expect(res.body.type).toBe('revision');
    expect(res.body.destinations).toEqual(['Rome', 'Florence']);
    expect(res.body.reply).toMatch(/Did you mean Barcelona/);
  });

  it('answer_only about destinations returns the clarifying question', async () => {
    const res = await revise(app, ['Rome', 'Milan'], ['answer_only', { answer: 'Which one should I swap — Rome or Milan?', aboutDestinations: true }]);
    expect(res.body).toEqual({ type: 'answer', reply: 'Which one should I swap — Rome or Milan?', aboutDestinations: true });
  });

  it('answer_only not about destinations tells the client to fall through', async () => {
    const res = await revise(app, ['Rome'], ['answer_only', { answer: '', aboutDestinations: false }]);
    expect(res.body.type).toBe('answer');
    expect(res.body.aboutDestinations).toBe(false);
  });

  it('503s when the AI call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('overloaded'));
    const res = await request(app).post('/api/plan/revise-destinations').send({ message: 'x', destinations: ['Rome'] });
    expect(res.status).toBe(503);
  });

  it('503s when there is no API key', async () => {
    (getAnthropicSafe as jest.Mock).mockReturnValue(null);
    const res = await request(app).post('/api/plan/revise-destinations').send({ message: 'x', destinations: ['Rome'] });
    expect(res.status).toBe(503);
  });

  it('400s without destinations', async () => {
    const res = await request(app).post('/api/plan/revise-destinations').send({ message: 'x', destinations: [] });
    expect(res.status).toBe(400);
  });
});

describe('applyDestinationOps', () => {
  it('ignores a replace to the same name and duplicate adds', () => {
    const r = applyDestinationOps(['Rome'], [
      { name: 'replace_destination', input: { old: 'Rome', new: 'rome' } },
      { name: 'add_destination', input: { city: 'ROME' } },
    ]);
    expect(r.destinations).toEqual(['Rome']);
    expect(r.changes).toEqual([]);
    expect(r.problems).toEqual(['ROME is already on your list']);
  });
});
