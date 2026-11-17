/**
 * The chat planner asks where the traveller flies from and whether they fly
 * back — it never guesses either (services/homeAnswers.ts).
 *
 * Production, 2026-11-17: "we are flying out of paris to london to go back to
 * paris and then munich" → the model set origin = Paris and returnToHome =
 * false, asked "How many people are traveling?", and four turns later said
 * "That's everything I need" without ever asking where they fly from or
 * round-trip vs one-way. The model outputs below are the ones it returned
 * live for that conversation (reproduced 2026-11-17 against the real API).
 *
 * The model is mocked; the route, the prompt and the rules are real.
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
import { acknowledgement, askedWhereFrom, saysRoundTripOrOneWay, saysThisIsHome } from '../services/homeAnswers';

const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
app.use(errorHandler);

const model = (input: any) => mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 'respond_to_traveler', input }] });
const turn = (message: string, known: any = {}, history: any[] = []) =>
  request(app).post('/api/plan/converse').send({ message, history, known });

const OWNER = 'we are flying out of paris to london to go back to paris and then munich';

beforeEach(() => jest.clearAllMocks());

describe('the owner\'s conversation', () => {
  it('turn 1: Paris is not taken as home, the trip is not made one-way, and it asks where they fly from', async () => {
    model({
      reply: "Got it — Paris → London → Paris → Munich. So you're starting from Paris, and it sounds like a multi-city route. How many people are traveling?",
      updates: { origin: 'Paris', destinations: ['London', 'Paris', 'Munich'], returnToHome: false },
      action: 'ask',
    });
    const res = await turn(OWNER);
    expect(res.status).toBe(200);
    expect(res.body.updates.origin).toBeUndefined();
    expect(res.body.updates.returnToHome).toBeUndefined();
    expect(res.body.updates.destinations).toEqual(['London', 'Paris', 'Munich']);
    expect(res.body.action).toBe('ask');
    expect(res.body.reply).toBe(
      'Got it — Paris → London → Paris → Munich. Just to check — are you flying from Paris, or starting the trip there after flying in from somewhere else?',
    );
    expect(res.body.quickReplies).toEqual(['Yes, from Paris', 'Flying in from somewhere else']);
  });

  it('"Yes, from Paris" makes Paris home (even if the model leaves it out)', async () => {
    model({ reply: 'Great. When are you going?', updates: {}, action: 'ask' });
    const res = await turn('Yes, from Paris', { destinations: ['London', 'Paris', 'Munich'] }, [
      { role: 'user', content: OWNER },
      { role: 'assistant', content: 'Just to check — are you flying from Paris, or starting the trip there after flying in from somewhere else?' },
    ]);
    expect(res.body.updates.origin).toBe('Paris');
  });

  it('a reply that does not answer the question is not taken as the origin (live: "Round-trip" became Paris)', async () => {
    model({ reply: "Round-trip it is — so you'll fly out of Paris and back. How many people?", updates: { origin: 'Paris', returnToHome: true }, action: 'ask' });
    const res = await turn('Round-trip', { destinations: ['London', 'Paris', 'Munich'] }, [
      { role: 'assistant', content: "Great route! Are you flying into Paris from somewhere else to start this trip, or is Paris where you're based and flying from?" },
    ]);
    expect(res.body.updates.origin).toBeUndefined();
    expect(res.body.updates.returnToHome).toBe(true);
    expect(res.body.quickReplies).toEqual(['Yes, from Paris', 'Flying in from somewhere else']);
  });

  it('"yes" to a question that named the city is taken', async () => {
    model({ reply: 'Paris it is.', updates: { origin: 'Paris' }, action: 'ask' });
    const res = await turn('yes', {}, [{ role: 'assistant', content: 'Just to check — are you flying from Paris, or starting the trip there after flying in from somewhere else?' }]);
    expect(res.body.updates.origin).toBe('Paris');
  });

  it('flying in from elsewhere: the answer to "where are you flying in from?" is taken', async () => {
    model({ reply: 'New York it is. When are you going?', updates: { origin: 'New York' }, action: 'ask' });
    const res = await turn('New York', { destinations: ['London', 'Paris', 'Munich'] }, [
      { role: 'assistant', content: 'Got it — where are you flying in from?' },
    ]);
    expect(res.body.updates.origin).toBe('New York');
  });

  it('"That\'s everything I need" is not allowed while round-trip vs one-way is unknown: it asks', async () => {
    model({
      reply: "Perfect, history and nature it is. That's everything — give it a look and hit Find my trip!",
      updates: { vibe: 'history and nature' },
      action: 'ready',
    });
    const known = { destinations: ['London', 'Paris', 'Munich'], origin: 'Paris', dates: { start: '2027-03-01', end: '2027-03-10' }, travelers: 2, notes: 'budget: skipped' };
    const res = await turn('history and nature', known);
    expect(res.body.action).toBe('ask');
    expect(res.body.reply).toBe('Perfect, history and nature it is. Last thing — are you flying back to Paris at the end (round-trip), or one-way?');
    expect(res.body.quickReplies).toEqual(['Round-trip', 'One-way']);
    expect(res.body.updates.vibe).toBe('history and nature');
  });

  it('"Round-trip" answers it (even if the model leaves it out), and then it may finish', async () => {
    model({ reply: "That's everything I need — hit Find my trip.", updates: {}, action: 'ready' });
    const known = { destinations: ['London', 'Paris', 'Munich'], origin: 'Paris', dates: { start: '2027-03-01', end: '2027-03-10' }, travelers: 2, vibe: 'history' };
    const res = await turn('Round-trip', known, [{ role: 'assistant', content: 'Last thing — are you flying back to Paris at the end (round-trip), or one-way?' }]);
    expect(res.body.updates.returnToHome).toBe(true);
    expect(res.body.action).toBe('ready');
  });

  it('"One-way" → false', async () => {
    model({ reply: 'One-way it is.', updates: {}, action: 'ready' });
    const known = { destinations: ['London'], origin: 'Paris', dates: { start: '2027-03-01', end: '2027-03-10' }, travelers: 2, vibe: 'history' };
    const res = await turn('One-way', known);
    expect(res.body.updates.returnToHome).toBe(false);
    expect(res.body.action).toBe('ready');
  });

  it('it can\'t finish without an origin either', async () => {
    model({ reply: "That's everything I need.", updates: {}, action: 'ready' });
    const res = await turn('2 of us', { destinations: ['London'], dates: { start: '2027-03-01', end: '2027-03-10' }, travelers: 2, returnToHome: true });
    expect(res.body.action).toBe('ask');
    expect(res.body.reply).toBe('Where are you flying from?');
  });
});

describe('when the traveller DID say it', () => {
  it('"I live in Paris" is home, no confirmation', async () => {
    model({ reply: 'Lovely. When?', updates: { origin: 'Paris', destinations: ['London', 'Munich'] }, action: 'ask' });
    const res = await turn('I live in Paris and want to see London and Munich', {});
    expect(res.body.updates.origin).toBe('Paris');
    expect(res.body.action).toBe('ask');
    expect(res.body.reply).toBe('Lovely. When?');
  });

  it('"round trip" in the first message is kept', async () => {
    model({ reply: 'Rome and Florence — great. When?', updates: { destinations: ['Rome', 'Florence'], returnToHome: true, origin: 'NYC' }, action: 'ask' });
    const res = await turn('From NYC to Rome and Florence, round trip', {});
    expect(res.body.updates.returnToHome).toBe(true);
    // "From NYC" alone is a route, not a home: one tap to confirm.
    expect(res.body.updates.origin).toBeUndefined();
    expect(res.body.quickReplies).toEqual(['Yes, from NYC', 'Flying in from somewhere else']);
  });

  it('a correction of an origin already given is taken', async () => {
    model({ reply: 'Boston then.', updates: { origin: 'Boston' }, action: 'ask' });
    const res = await turn("actually we're flying from Boston", { origin: 'New York' });
    expect(res.body.updates.origin).toBe('Boston');
  });

  it('with a country to pick cities in, the picker still shows (origin is asked after)', async () => {
    model({ reply: 'Germany — which cities?', updates: { origin: 'Paris', countries: [{ country: 'Germany', cities: ['Munich', 'Berlin'] }] }, action: 'show_city_picker' });
    const res = await turn('we are flying from paris to london to germany', {});
    expect(res.body.action).toBe('show_city_picker');
    expect(res.body.updates.origin).toBeUndefined();
  });
});

describe('the rules', () => {
  it('round-trip words', () => {
    for (const yes of ['Round-trip', 'round trip please', 'one way', 'One-way', 'we fly back home on the 10th', 'return flight too', 'RT']) expect(saysRoundTripOrOneWay(yes)).toBe(true);
    for (const no of [OWNER, 'Paris to London, back to Paris, then Munich', 'March 1 to 10', 'roundabout']) expect(saysRoundTripOrOneWay(no)).toBe(false);
  });

  it('home statements', () => {
    expect(saysThisIsHome('I live in Paris', 'Paris')).toBe(true);
    expect(saysThisIsHome("we're based in Paris", 'Paris')).toBe(true);
    expect(saysThisIsHome("I'm from New York", 'New York')).toBe(true);
    expect(saysThisIsHome('Paris is home', 'Paris')).toBe(true);
    expect(saysThisIsHome(OWNER, 'Paris')).toBe(false);
    expect(saysThisIsHome('flying from Paris', 'Paris')).toBe(false);
  });

  it('origin questions', () => {
    expect(askedWhereFrom('Where are you flying from?')).toBe(true);
    expect(askedWhereFrom('Got it — where are you flying in from?')).toBe(true);
    expect(askedWhereFrom('How many people are traveling?')).toBe(false);
  });

  it('the acknowledgement keeps what was heard, drops the guess and the question', () => {
    expect(acknowledgement("Got it — Paris → London → Paris → Munich. So you're starting from Paris, and it sounds like a multi-city route. How many people are traveling?"))
      .toBe('Got it — Paris → London → Paris → Munich.');
    expect(acknowledgement("That's everything I need — give it a look and hit Find my trip.")).toBe('');
  });
});

describe('the prompt says so too', () => {
  it('round-trip vs one-way is a minimum, and a route start is not a home', async () => {
    model({ reply: 'ok', updates: {}, action: 'ask' });
    await turn('hi');
    const system = mockCreate.mock.calls[0][0].system as string;
    expect(system).toMatch(/ALL five required/);
    expect(system).toMatch(/A route that begins in a city/);
    expect(system).toMatch(/"back to Paris" mid-trip is a stop, not a return home/);
  });
});
