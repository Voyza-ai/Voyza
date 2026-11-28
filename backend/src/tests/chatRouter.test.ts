/**
 * Chat model routing (chatRouter.ts) — the parts that need no model:
 * tier-0 templates and the questions that must NOT get one, the pre-filter
 * that sends a question straight to tier 2, proposal detection on the history
 * the chat panel really sends, and the guard on a tier-1 answer.
 */
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

import {
  calendarNote,
  chatRoutingMode,
  guardProblem,
  isProposalTurn,
  prefilter,
  shadowAgreement,
  tier0,
} from '../services/chatRouter';
import { costUsd } from '../services/aiUsage';
import { notALegReply, tripLegs, whichLegReply } from '../services/tripLegs';

const base = require('./fixtures/chat-trip-nyc-paris-london.json');
const trip = () => JSON.parse(JSON.stringify(base));
const GREETING = { role: 'assistant' as const, content: "You're working on a 2-city trip. Ask me anything — swap transports, shift dates, rework a city, or ask why things are ordered this way." };

describe('tier 0: template answers from the trip', () => {
  it.each([
    ['What time is our flight home?', 'home_time', 'Your flight home (London → New York) leaves at 12:23 and arrives at 15:24 on Jan 17 — American Airlines.'],
    ['When does the flight out leave?', 'out_time', 'Your flight out (New York → Paris) leaves at 08:30 and arrives at 22:48 on Jan 12 — British Airways.'],
    ['Which hotel in Paris?', 'hotel_in', "In Paris you're staying at Ibis Styles Paris Batignolles (Jan 12–15)."],
    ['which hotel are we staying at in london', 'hotel_in', "In London you're staying at hub London - Marylebone (Jan 15–17)."],
    ['When do we arrive in Paris?', 'arrive_in', 'You arrive in Paris on Jan 12: your flight out (New York → Paris) leaves at 08:30 and arrives at 22:48 — British Airways.'],
    ['How many nights in Paris?', 'nights_in', '3 nights in Paris (Jan 12–15).'],
    ['How long is the flight from Paris to London?', 'leg_len', 'Paris → London is 58m by flight (American Airlines).'],
    ['Which cities are we visiting?', 'cities', 'Your trip: Paris (Jan 12–15), then London (Jan 15–17).'],
  ])('%s → %s', (q, intent, reply) => {
    expect(tier0(q, trip(), [GREETING])).toEqual({ intent, reply });
  });

  it.each([
    ['two requests', 'what time is our flight home and can we leave later?'],
    ['a back-reference', 'what time is the flight home on the cheaper one?'],
    ['a city not on the trip', 'which hotel in Rome?'],
    ['a question the pattern does not cover', 'which hotel in Paris is cheapest?'],
    ['a condition', 'when do we get to London if we skip Paris?'],
    ['no leg named', 'how long is the train?'],
    ['the wrong mode for the leg', 'how long is the train from Paris to London?'],
    // Paris → London lands "before" it leaves (time zones) with no arrival day: times are not stated.
    ['a leg whose arrival day is unknown', 'when do we get to London?'],
    ['a substring of a city', 'which hotel in par?'],
  ])('not tier 0: %s', (_why, q) => {
    expect(tier0(q, trip(), [])).toBeNull();
  });

  it('not tier 0 right after a proposal, even for a template question', () => {
    const h = [GREETING, { role: 'user' as const, content: 'later flight home' }, { role: 'assistant' as const, content: 'Switch to BA 19:25… Accept to switch, or Reject to keep it as it is.\n\n[The user has not accepted this change yet; the trip is unchanged.]' }];
    expect(tier0('What time is our flight home?', trip(), h)).toBeNull();
  });

  it('a city visited twice, a missing return leg or no current option: no template', () => {
    const twice = trip();
    twice.cities.push({ ...twice.cities[0], dates: { arrival: '2027-01-17', departure: '2027-01-19' } });
    expect(tier0('which hotel in Paris?', twice, [])).toBeNull();

    const oneWay = trip();
    oneWay.returnToHome = false;
    oneWay.origin.returnLeg = null;
    expect(tier0('what time is our flight home?', oneWay, [])).toBeNull();

    const none = trip();
    none.origin.returnLeg = null;
    expect(tier0('what time is our flight home?', none, [])).toBeNull();
  });

  it('an overnight home flight states its landing day; one without a landing day and arriving "earlier" is refused', () => {
    const t = trip();
    t.origin.returnLeg.departTime = '22:10';
    t.origin.returnLeg.arriveTime = '06:05';
    t.origin.returnLeg.arriveDate = '2027-01-18';
    expect(tier0('what time is our flight home?', t, [])?.reply).toContain('arrives Jan 18 at 06:05');
    delete t.origin.returnLeg.arriveDate;
    expect(tier0('what time is our flight home?', t, [])).toBeNull();
  });

  it('a custom hotel wins over the picked one', () => {
    const t = trip();
    t.cities[0].customHotel = { name: 'Chez Marie' };
    expect(tier0('which hotel in paris', t, [])?.reply).toContain('Chez Marie');
  });
});

describe('pre-filter: straight to tier 2', () => {
  it.each([
    ['change my flight home', 'change'],
    ["we'd rather fly", 'prefer'],
    ['can we stay longer in Paris?', 'prefer'],
    ['make Rome 4 nights', 'prefer'],
    ['push everything a day', 'prefer'],
    ['is there a direct option?', 'search'],
    ['how much is the hotel?', 'price'],
    ['will I need a coat in London?', 'weather'],
    ['Why Paris before London?', 'why'],
    ['flight or train to London — which is faster?', 'compare'],
    ['somewhere nice for dinner?', 'dining'],
    ['any sights to visit in Paris?', 'plans'],
  ])('%s → %s', (q, rule) => {
    expect(prefilter(q, [])).toEqual({ rule });
  });

  it('follow-ups go to tier 2: after a proposal, a back-reference, a short reply, an unnamed leg', () => {
    const proposal = { role: 'assistant' as const, content: "Here's your trip as London → Paris. Accept to apply it.\n\n[The user has not accepted this change yet; the trip is unchanged.]" };
    expect(prefilter('what time is our flight home?', [GREETING, { role: 'user', content: 'swap them' }, proposal])).toEqual({ rule: 'after_proposal' });
    expect(prefilter('yes please', [])).toEqual({ rule: 'back_reference' });
    expect(prefilter('the second one', [])).toEqual({ rule: 'back_reference' });
    const talk = [GREETING, { role: 'user' as const, content: 'tell me about the Paris to London leg' }, { role: 'assistant' as const, content: 'It is a 58m flight.' }];
    expect(prefilter('what about Tuesday', talk)).toEqual({ rule: 'short_followup' });
    expect(prefilter('what time does the flight leave?', talk)).toEqual({ rule: 'unnamed_leg' });
  });

  it('the greeting alone is not a conversation: a short first question still reaches tier 1', () => {
    expect(prefilter('plan for Thursday?', [GREETING])).toBeNull();
  });

  it('plain questions pass through to tier 1', () => {
    expect(prefilter("what's the plan on Thursday?", [GREETING])).toBeNull();
    expect(prefilter('how long is the train?', [GREETING])).toBeNull();
  });
});

describe('proposal detection matches what the server and the chat panel really send', () => {
  const legs = tripLegs(trip());
  it.each([
    ['ask_which_leg (several legs)', whichLegReply(legs)],
    ['ask_which_leg (one leg)', whichLegReply(legs.slice(0, 1))],
    ['a non-leg', notALegReply(legs, { fromName: 'Rome', toName: 'Paris' })],
    ['a transport proposal', 'Switching to British Airways LHR 19:25 → JFK 22:40 on Jan 17, $820. Accept to switch, or Reject to keep it as it is.'],
    ['a city edit', "Here's your trip as London → Paris. Accept to apply it."],
    ['the panel: pending', 'anything\n\n[The user has not accepted this change yet; the trip is unchanged.]'],
    ['the panel: accepted', 'anything\n\n[The user accepted this change; the trip now includes it.]'],
    ['which city', 'Which city did you mean? Tell me the name and I’ll work it out.'],
  ])('%s', (_name, text) => {
    expect(isProposalTurn(text)).toBe(true);
  });
  it('an ordinary answer is not a proposal', () => {
    expect(isProposalTurn('Your flight home leaves at 12:23.')).toBe(false);
  });
});

describe('tier-1 guard', () => {
  const t = trip();
  const ctx = `${JSON.stringify(t)} 2027-01-12 2027-01-14 2027-01-17 12:23 15:24 ${calendarNote(t)}`;
  it('accepts an answer built only from the trip', () => {
    expect(guardProblem('On Thu Jan 14 you are in Paris, at Ibis Styles Paris Batignolles.', t, ctx)).toBeNull();
  });
  it.each([
    ['a number not in the trip', 'Your flight home leaves at 13:45.', 'number_not_in_context'],
    ['a wrong weekday', 'On Fri Jan 14 you are in Paris.', 'weekday_wrong'],
    ['a date not on the trip', 'On Mar 3 you are in Paris.', 'date_not_in_context'],
    ['money', 'The hotel is $450.', 'money'],
    ['claiming a change', "I've switched your flight home.", 'claims_change'],
    ['weather', 'Expect rain in London.', 'weather'],
    ['a city off the trip', 'On Thursday you are in Rome.', 'city_not_in_trip'],
  ])('rejects %s', (_why, answer, problem) => {
    expect(guardProblem(answer, t, ctx)).toMatch(new RegExp(`^${problem}`));
  });
});

describe('switch, shadow verdicts and cost', () => {
  const saved = process.env.CHAT_ROUTING;
  afterEach(() => (process.env.CHAT_ROUTING = saved));
  it('CHAT_ROUTING defaults to off', () => {
    delete process.env.CHAT_ROUTING;
    expect(chatRoutingMode()).toBe('off');
    process.env.CHAT_ROUTING = 'nonsense';
    expect(chatRoutingMode()).toBe('off');
    process.env.CHAT_ROUTING = 'Shadow';
    expect(chatRoutingMode()).toBe('shadow');
  });
  it('shadow: a cheap answer where tier 2 used a tool, or stated other facts, is DANGEROUS', () => {
    expect(shadowAgreement({ tier: 0, reply: 'leaves at 12:23 on Jan 17', reason: 'home_time' }, 'answer_only', 'It departs Jan 17 at 12:23.')).toBe('safe');
    expect(shadowAgreement({ tier: 1, reply: 'leaves at 12:23', reason: 'answer' }, 'find_transport_option', '')).toBe('DANGEROUS');
    expect(shadowAgreement({ tier: 0, reply: 'arrives at 09:00', reason: 'arrive_in' }, 'answer_only', 'It arrives at 10:48.')).toBe('DANGEROUS');
    expect(shadowAgreement({ tier: 2, reason: 'prefilter:why' }, 'answer_only', 'x')).toBe('missed_saving');
  });
  it('cost per call from usage, cache reads and writes included', () => {
    // 1,000 in + 1,000 cache read + 1,000 cache write + 100 out on Sonnet 4.5: $0.003 + $0.0003 + $0.00375 + $0.0015
    expect(costUsd('claude-sonnet-4-5', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 })).toBeCloseTo(0.00855, 6);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 2500, output_tokens: 60 })).toBeCloseTo(0.00028, 6);
    expect(costUsd('some-other-model', { input_tokens: 1 })).toBeNull();
  });
});
