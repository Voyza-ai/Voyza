/**
 * POST /api/plan/chat with model routing (CHAT_ROUTING) and prompt caching.
 *
 * The model is scripted (mocked messages.create): the test sees every request
 * the server makes — which model, which tools, how many calls — so routing is
 * checked without a live call.
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
  DEFAULT_MODEL: 'claude-test-tier2',
}));
jest.mock('../services/flights', () => ({ searchFlights: jest.fn(), getIataCode: jest.fn(async (c: string) => c.slice(0, 3).toUpperCase()) }));
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { logger } from '../utils/logger';
import { CHAT_TOOLS, chatSystemBlocks } from '../services/tripChat';
import { TIER1_MODEL } from '../services/chatRouter';
import { withPriceUnits } from '../services/tripLegs';

const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
app.use(errorHandler);

const base = require('./fixtures/chat-trip-nyc-paris-london.json');
const trip = () => JSON.parse(JSON.stringify(base));
const GREETING = { role: 'assistant', content: "You're working on a 2-city trip. Ask me anything — swap transports, shift dates, rework a city, or ask why things are ordered this way." };
const ask = (message: string, history: any[] = [GREETING], currentTrip = trip()) =>
  request(app).post('/api/plan/chat').send({ message, currentTrip, history });

/** Script the models: tier 1 (Haiku) gets `haiku`, tier 2 gets `sonnet`. */
function script(haiku: any, sonnet: any = { content: [{ type: 'tool_use', name: 'answer_only', input: { answer: 'Tier-2 answer.' } }] }) {
  mockCreate.mockImplementation(async (req: any) => (req.model === TIER1_MODEL ? haiku : sonnet));
}
const haikuAnswer = (answer: string) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'answer', input: { answer } }] });
const haikuEscalate = (reason: string) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'escalate', input: { reason } }] });
const models = () => mockCreate.mock.calls.map((c) => c[0].model);

const saved = process.env.CHAT_ROUTING;
beforeEach(() => {
  mockCreate.mockReset();
  delete process.env.CHAT_ROUTING;
});
afterAll(() => (process.env.CHAT_ROUTING = saved));

describe('CHAT_ROUTING unset (default): exactly today’s single call', () => {
  it('one tier-2 call with every chat tool, even for a template question', async () => {
    script(haikuAnswer('x'));
    const res = await ask('What time is our flight home?');
    expect(res.body).toEqual({ type: 'answer', reply: 'Tier-2 answer.' });
    expect(models()).toEqual(['claude-test-tier2']);
    expect(mockCreate.mock.calls[0][0].tools.map((t: any) => t.name)).toEqual(CHAT_TOOLS.map((t: any) => t.name));
  });
});

describe('CHAT_ROUTING=on', () => {
  beforeEach(() => (process.env.CHAT_ROUTING = 'on'));

  it('tier 0: a plain lookup is answered from the trip with NO model call', async () => {
    script(haikuAnswer('x'));
    const res = await ask('What time is our flight home?');
    expect(res.body).toEqual({ type: 'answer', reply: 'Your flight home (London → New York) leaves at 12:23 and arrives at 15:24 on Jan 17 — American Airlines.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('tier 1: Haiku gets ONLY answer / escalate — never a trip-changing tool — and its guarded answer is used', async () => {
    script(haikuAnswer('On Thu Jan 14 you are in Paris, staying at Ibis Styles Paris Batignolles.'));
    const res = await ask("What's the plan on Thursday?");
    expect(res.body).toEqual({ type: 'answer', reply: 'On Thu Jan 14 you are in Paris, staying at Ibis Styles Paris Batignolles.' });
    expect(models()).toEqual([TIER1_MODEL]);
    const req = mockCreate.mock.calls[0][0];
    expect(req.tools.map((t: any) => t.name)).toEqual(['answer', 'escalate']);
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.messages[req.messages.length - 1].content).toContain('Thu Jan 14 = 2027-01-14'); // weekdays come from code
    expect(req.messages.some((m: any) => /Ask me anything/.test(m.content))).toBe(false); // the greeting isn't history
  });

  it('tier 1 escalates → tier 2 runs today’s path (2 calls)', async () => {
    script(haikuEscalate('unsure'));
    const res = await ask('Is the London hotel near the station?');
    expect(res.body.reply).toBe('Tier-2 answer.');
    expect(models()).toEqual([TIER1_MODEL, 'claude-test-tier2']);
  });

  it('a tier-1 answer that fails the guard (invented time) is never sent: tier 2 answers', async () => {
    script(haikuAnswer('Your flight home leaves at 13:45.'));
    const res = await ask('Tell me about our flight home');
    expect(res.body.reply).toBe('Tier-2 answer.');
    expect(models()).toEqual([TIER1_MODEL, 'claude-test-tier2']);
  });

  it('a Haiku failure or a malformed reply falls back to tier 2', async () => {
    mockCreate.mockImplementation(async (req: any) => {
      if (req.model === TIER1_MODEL) throw new Error('overloaded');
      return { content: [{ type: 'tool_use', name: 'answer_only', input: { answer: 'Tier-2 answer.' } }] };
    });
    expect((await ask('Tell me about our flight home')).body.reply).toBe('Tier-2 answer.');
    script({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] });
    expect((await ask('Tell me about our flight home')).body.reply).toBe('Tier-2 answer.');
  });

  it('changes and follow-ups skip Haiku: ONE tier-2 call, and proposals still come back as proposals', async () => {
    script(haikuAnswer('x'), { content: [{ type: 'tool_use', name: 'ask_which_leg', input: {} }] });
    const change = await ask('Can we get a later flight?');
    expect(models()).toEqual(['claude-test-tier2']);
    expect(change.body.type).toBe('answer');
    expect(change.body.reply).toMatch(/^Which one —/);

    mockCreate.mockClear();
    const proposal = { role: 'assistant', content: "Here's your trip as London → Paris. Accept to apply it.\n\n[The user has not accepted this change yet; the trip is unchanged.]" };
    await ask('What time is our flight home?', [GREETING, { role: 'user', content: 'swap the cities' }, proposal]);
    expect(models()).toEqual(['claude-test-tier2']);
  });

  it('logs the tier and the reason, never the message', async () => {
    const info = jest.spyOn(logger, 'info');
    script(haikuAnswer('x'));
    await ask('Which hotel in Paris?');
    const line = info.mock.calls.find((c) => c[0] === 'chat route');
    expect(line?.[1]).toEqual({ mode: 'on', tier: 0, reason: 'hotel_in' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('Which hotel in Paris');
    info.mockRestore();
  });
});

describe('CHAT_ROUTING=shadow: tier 2 answers, the router only logs', () => {
  beforeEach(() => (process.env.CHAT_ROUTING = 'shadow'));
  it('the reply is tier 2’s; the log says what the router would have done and whether it agreed', async () => {
    const info = jest.spyOn(logger, 'info');
    script(haikuAnswer('x'), { content: [{ type: 'tool_use', name: 'answer_only', input: { answer: 'It leaves Jan 17 at 12:23 and lands at 15:24.' } }] });
    const res = await ask('What time is our flight home?');
    expect(res.body.reply).toBe('It leaves Jan 17 at 12:23 and lands at 15:24.');
    await new Promise((r) => setImmediate(r));
    const line = info.mock.calls.find((c) => c[0] === 'chat route shadow');
    expect(line?.[1]).toEqual({ wouldTier: 0, reason: 'home_time', sonnetTool: 'answer_only', agreement: 'safe' });
    info.mockRestore();
  });
});

describe('prompt caching', () => {
  it('the last tool carries a cache breakpoint; CHAT_TOOLS itself is untouched', async () => {
    script(haikuAnswer('x'));
    await ask('hello there');
    const tools = mockCreate.mock.calls[0][0].tools;
    expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.slice(0, -1).every((t: any) => !t.cache_control)).toBe(true);
    expect((CHAT_TOOLS[CHAT_TOOLS.length - 1] as any).cache_control).toBeUndefined();
  });

  it('system is two cached blocks; block 1 is byte-identical across trips, days and price modes', async () => {
    script(haikuAnswer('x'));
    await ask('hello there');
    const sys = mockCreate.mock.calls[0][0].system;
    expect(sys).toHaveLength(2);
    expect(sys.every((b: any) => b.cache_control?.type === 'ephemeral')).toBe(true);

    const other = trip();
    other.cities.reverse();
    const a = chatSystemBlocks(trip())[0].text;
    const b = withPriceUnits('perPerson', 2, () => chatSystemBlocks(other)[0].text);
    jest.useFakeTimers().setSystemTime(new Date('2027-03-01T12:00:00Z'));
    const c = chatSystemBlocks(trip())[0].text;
    jest.useRealTimers();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).not.toMatch(/Today is|PER-PERSON|TRIP CONTEXT \(read-only\)/);
    expect(chatSystemBlocks(trip())[1].text).toMatch(/^Today is \d{4}-\d{2}-\d{2}/);
  });
});
