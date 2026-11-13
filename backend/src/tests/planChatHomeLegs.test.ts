/**
 * POST /api/plan/chat — changing the flights to and from home, and any leg,
 * exactly as asked.
 *
 * The trip is the real one from production (New York → Paris → London,
 * Jan 12–17 2027, 2 travellers; fixtures/chat-trip-nyc-paris-london.json).
 * There the flight home on screen was American Airlines London 12:23 → JFK
 * 15:24, $432, and:
 *  - "Change my flight home from London to a later one, in the evening" got
 *    "London → Paris isn't a leg of this trip — its only leg is Paris →
 *    London";
 *  - "Show me evening flights from London back to New York on Jan 17" got
 *    "there's no return transport booked yet".
 * The model was never told about home (only cities and each city's
 * transportOut, the last one an empty placeholder), and every leg tool took
 * only two consecutive trip cities.
 *
 * The model is scripted (a mocked Anthropic tool call); the route, the leg
 * model, the home-flight search (optimizer.searchHomeLegOptions) and the
 * inter-city search (legOptions.ts) are real. Only Duffel and rail are faked.
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

jest.mock('../services/flights', () => ({
  searchFlights: jest.fn(),
  getIataCode: jest.fn(async (city: string) => city.slice(0, 3).toUpperCase()),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

const mockCompareLeg = jest.fn();
jest.mock('../services/compareLeg', () => ({
  compareLeg: (p: any) => mockCompareLeg(p),
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { getAnthropicSafe } from '../services/anthropic';
import { headerTotal, tripLegs, verifyTransportProposal } from '../services/tripLegs';
import { runTripChat } from '../services/tripChat';
import tripFixture from './fixtures/chat-trip-nyc-paris-london.json';
const { searchFlights } = require('../services/flights');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);
  return app;
}

/** The production trip, fresh each time (the route must never mutate it). */
const trip = (): any => JSON.parse(JSON.stringify(tripFixture));

/** A Duffel-shaped offer. `arr` may carry "+1" for a next-day landing. */
const offer = (carrier: string, code: string, price: number, date: string, dep: string, arr: string, mins = 480) => {
  const nextDay = arr.endsWith('+1');
  const arrDate = nextDay
    ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : date;
  return {
    id: `off_${code}_${dep}_${price}`,
    price,
    currency: 'USD',
    departure: `${date}T${dep}:00`,
    arrival: `${arrDate}T${arr.replace('+1', '')}:00`,
    durationMinutes: mins,
    stops: 0,
    carrier,
    carrierCode: code,
    bookingUrl: 'https://example.test',
    raw: {},
  };
};

/**
 * Duffel, as the searches would answer for this trip. getIataCode is mocked
 * to the first three letters: London = LON, Paris = PAR.
 */
const OFFERS: Record<string, any[]> = {
  // Flight home, Sun Jan 17: the card's four plus evening and morning ones.
  'LON|JFK|2027-01-17': [
    offer('American Airlines', 'AA', 432.18, '2027-01-17', '12:23', '15:24'),
    offer('Iberia', 'IB', 438.66, '2027-01-17', '12:23', '15:24'),
    offer('British Airways', 'BA', 510.4, '2027-01-17', '19:25', '22:31'),
    offer('American Airlines', 'AA', 468.9, '2027-01-17', '20:40', '23:50'),
  ],
  'LON|EWR|2027-01-17': [
    offer('British Airways', 'BA', 435.36, '2027-01-17', '12:23', '15:25'),
    offer('American Airlines', 'AA', 443.66, '2027-01-17', '12:23', '15:25'),
    offer('Virgin Atlantic', 'VS', 455.1, '2027-01-17', '18:05', '21:15'),
  ],
  'LON|LGA|2027-01-17': [offer('Delta', 'DL', 399, '2027-01-17', '07:10', '10:05')],
  // Flight out, Tue Jan 12.
  'JFK|PAR|2027-01-12': [
    offer('British Airways', 'BA', 449.76, '2027-01-12', '08:30', '22:48'),
    offer('Iberia', 'IB', 452.48, '2027-01-12', '08:30', '22:48'),
    offer('American Airlines', 'AA', 464.16, '2027-01-12', '08:30', '22:48'),
    offer('Air France', 'AF', 470, '2027-01-12', '18:30', '07:55+1'),
    offer('Delta', 'DL', 462, '2027-01-12', '21:15', '10:40+1'),
  ],
  'LGA|PAR|2027-01-12': [offer('American Airlines', 'AA', 450.12, '2027-01-12', '08:30', '22:48')],
  'EWR|PAR|2027-01-12': [offer('United', 'UA', 480, '2027-01-12', '10:15', '23:40')],
  // Paris → London, Fri Jan 15.
  'PAR|LON|2027-01-15': [
    offer('American Airlines', 'AA', 79.84, '2027-01-15', '10:50', '10:48', 58),
    offer('British Airways', 'BA', 80.4, '2027-01-15', '10:50', '10:48', 58),
    offer('Iberia', 'IB', 80.86, '2027-01-15', '10:50', '10:48', 58),
    offer('easyJet', 'U2', 134.23, '2027-01-15', '17:10', '17:15', 65),
    offer('Air France', 'AF', 95.1, '2027-01-15', '14:05', '14:20', 75),
  ],
};

async function chat(app: express.Express, name: string, input: any, t: any = trip(), message = 'x', history: any[] = []) {
  mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name, input }] });
  return request(app).post('/api/plan/chat').send({ message, currentTrip: t, history });
}

const searchedRoutes = () =>
  searchFlights.mock.calls.map((c: any[]) => `${c[0].origin}|${c[0].destination}|${c[0].date}`).sort();

const FROZEN_NOW = '2026-11-11T15:00:00Z';
beforeAll(() => {
  jest.useFakeTimers({
    now: new Date(FROZEN_NOW),
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
      'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
      'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ],
  });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
  searchFlights.mockImplementation(async ({ origin, destination, date }: any) => OFFERS[`${origin}|${destination}|${date}`] ?? []);
});

const app = createApp();

describe('the model sees home, every leg, and every option on its card', () => {
  it('lists home, the three legs with ids, their current options and card options with ids', async () => {
    // The production trip totals $1,576 on the header (hotels + legs + both
    // home flights), and the server sums it the same way.
    expect(trip().totalCost).toBe(1576);
    expect(headerTotal(trip())).toBe(1576);
    await chat(app, 'answer_only', { answer: 'ok' });
    const system: string = mockCreate.mock.calls[0][0].system;
    const ctx = JSON.parse(system.slice(system.indexOf('TRIP CONTEXT (read-only):') + 'TRIP CONTEXT (read-only):'.length));
    expect(ctx.home).toEqual({ city: 'New York', airports: ['JFK', 'LGA', 'EWR'], returnsHome: true });
    expect(ctx.legs.map((l: any) => l.id)).toEqual(['home→Paris', 'Paris→London', 'London→home']);
    const ret = ctx.legs[2];
    expect(ret).toMatchObject({ from: 'London', to: 'New York (home)', date: '2027-01-17' });
    expect(ret.current).toMatchObject({
      optionId: 'London→home#0', operator: 'American Airlines', depart: 'LON 12:23 2027-01-17', arrive: 'JFK 15:24', price: 432.18,
    });
    expect(ret.cardOptions.map((o: any) => [o.optionId, o.operator, o.price, o.priceChange])).toEqual([
      ['London→home#1', 'British Airways', 435.36, 3.18],
      ['London→home#2', 'Iberia', 438.66, 6.48],
      ['London→home#3', 'American Airlines', 443.66, 11.48],
    ]);
    expect(ctx.legs[0]).toMatchObject({ from: 'New York (home)', to: 'Paris', date: '2027-01-12' });
    expect(ctx.legs[0].current).toMatchObject({ operator: 'British Airways', depart: 'JFK 08:30 2027-01-12', price: 449.76 });
    // The last city's empty placeholder is no longer what the model reads
    // as "the flight home" (it said "no return transport booked yet").
    expect(ctx.cities[1]).not.toHaveProperty('transportOut');
    expect(system).toContain('"→home"');
  });
});

describe('the two production asks', () => {
  it('"Change my flight home from London to a later one, in the evening" → the cheapest later evening flight, priced', async () => {
    const posted = trip();
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', relative: 'later', timeOfDay: 'evening' }, posted);
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.kind).toBe('transport_change');
    expect(p.leg).toMatchObject({ id: 'London→home', kind: 'return' });
    expect(p.before).toMatchObject({ operator: 'American Airlines', departTime: '12:23', price: 432.18 });
    // Evening (≥ 17:00) and later than 12:23: VS 18:05 $455.10, AA 20:40
    // $468.90, BA 19:25 $510.40 — the cheapest is proposed.
    expect(p.after).toMatchObject({ operator: 'Virgin Atlantic', departTime: '18:05', arriveTime: '21:15', fromAirport: 'LON', toAirport: 'EWR', departDate: '2027-01-17', price: 455.1 });
    expect(p.priceDelta).toBe(22.92);
    expect(p.totals).toEqual({ before: 1576, after: 1599, delta: 23 });
    expect(p.firstStay).toBeNull();
    expect(res.body.reply).toMatch(/^The cheapest later evening flight home \(London → New York\) I found: Virgin Atlantic LON 18:05 → EWR 21:15 on Jan 17, \$455 instead of American Airlines LON 12:23 → JFK 15:24 at \$432\./);
    expect(res.body.reply).toContain('Trip total $1,576 → $1,599 (+$23)');
    expect(res.body.reply).not.toMatch(/isn't a leg/);
    // Every home airport was searched, from London, on the return day.
    expect(searchedRoutes()).toEqual(['LON|EWR|2027-01-17', 'LON|JFK|2027-01-17', 'LON|LGA|2027-01-17']);
    // Nothing is applied by the server.
    expect(posted).toEqual(trip());
  });

  it('"Show me evening flights from London back to New York on Jan 17" → lists them, changes nothing', async () => {
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', timeOfDay: 'evening', list: true });
    expect(res.body.type).toBe('leg_options');
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.legOptions.leg).toMatchObject({ id: 'London→home', kind: 'return' });
    expect(res.body.legOptions.options.map((o: any) => `${o.operator} ${o.departTime} ${o.price}`)).toEqual([
      'Virgin Atlantic 18:05 455.1',
      'American Airlines 20:40 468.9',
      'British Airways 19:25 510.4',
    ]);
    expect(res.body.reply).toContain('1. Virgin Atlantic LON 18:05 → EWR 21:15 — $455 (+$23)');
    expect(res.body.reply).toContain('Nothing has changed yet');
    expect(res.body.reply).not.toMatch(/no return/i);
  });

  it('the old leg tools take a home leg too (set_transport_window London → New York after 17:00 → a proposal)', async () => {
    const res = await chat(app, 'set_transport_window', {
      from: 'London', to: 'New York', earliestDepart: '5pm', latestDepart: null, earliestArrive: null, latestArrive: null, explanation: 'x',
    });
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.after).toMatchObject({ operator: 'Virgin Atlantic', departTime: '18:05' });
    expect(res.body.proposal.request.window.earliestDepart).toBe('17:00');
  });

  it('show_transport_options on the flight home lists the cheapest options on its card', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'London', to: 'home', explanation: 'x' });
    expect(res.body.type).toBe('leg_options');
    // The current AA 12:23 is not listed as an "option" to itself.
    expect(res.body.legOptions.options[0]).toMatchObject({ operator: 'Delta', departTime: '07:10', price: 399 });
    expect(res.body.legOptions.options.some((o: any) => o.operator === 'American Airlines' && o.departTime === '12:23' && o.toAirport === 'JFK')).toBe(false);
    // No more than the card keeps (frontend MAX_ALTERNATIVES = 4): the reply
    // says they are all on the card, so every listed option must fit there.
    expect(res.body.legOptions.totalFound).toBe(7);
    expect(res.body.legOptions.options).toHaveLength(4);
    expect(res.body.reply).toContain('(7 found, cheapest 4 shown)');
    expect(res.body.reply).not.toMatch(/^5\. /m);
  });
});

describe('switching to a named option', () => {
  it('"switch my flight home to the British Airways one" → exactly that card option, no search', async () => {
    const res = await chat(app, 'select_transport_option', { leg: 'London→home', optionId: 'London→home#1' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.after).toMatchObject({ optionId: 'London→home#1', operator: 'British Airways', departTime: '12:23', toAirport: 'EWR', price: 435.36 });
    expect(p.priceDelta).toBe(3.18);
    expect(p.totals).toEqual({ before: 1576, after: 1579, delta: 3 });
    expect(res.body.reply).toContain('Switch your flight home (London → New York) to British Airways LON 12:23 → EWR 15:25');
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('"the British Airways one" by airline name alone → that card option, no search', async () => {
    const res = await chat(app, 'select_transport_option', { leg: 'London→home', operator: 'British Airways' });
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.after).toMatchObject({ operator: 'British Airways', price: 435.36 });
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('an airline not on the card is searched for, not asked about (live: a listing had replaced the card)', async () => {
    const t = trip();
    t.origin.returnLeg.alternatives = t.origin.returnLeg.alternatives.filter((a: any) => !/british/i.test(a.operator));
    const res = await chat(app, 'select_transport_option', { leg: 'London→home', operator: 'British Airways' }, t);
    expect(res.body.type).toBe('proposal');
    // The cheapest British Airways flight home the search finds: EWR 12:23 $435.36.
    expect(res.body.proposal.after).toMatchObject({ operator: 'British Airways', departTime: '12:23', toAirport: 'EWR', price: 435.36 });
    expect(res.body.reply).toMatch(/^The cheapest British Airways flight home \(London → New York\) I found:/);
    expect(searchFlights).toHaveBeenCalled();
  });

  it('finds the leg from the option id alone, and says so when the option is already the current one', async () => {
    const res = await chat(app, 'select_transport_option', { optionId: 'London→home#0' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('already your flight home');
  });

  it('answers with the card\'s real options for an option id that is not on it', async () => {
    const res = await chat(app, 'select_transport_option', { leg: 'London→home', optionId: 'London→home#9' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('British Airways');
    expect(res.body.reply).toContain('Iberia');
  });
});

describe('date edits are priced before they are proposed', () => {
  it('"at least 3 nights in London" → London Jan 15–18 and the flight home searched on Jan 18, with the constraint', async () => {
    searchFlights.mockImplementation(async ({ origin, destination, date }: any) =>
      origin === 'LON' && destination === 'JFK' && date === '2027-01-18'
        ? [offer('American Airlines', 'AA', 440.5, '2027-01-18', '13:09', '16:10')]
        : []);
    const res = await chat(app, 'set_min_days', { city: 'London', minNights: 3, explanation: 'Giving you three nights in London.' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p).toMatchObject({ kind: 'city_edit', toolName: 'set_min_days', op: { kind: 'dates', city: 'London' } });
    expect(p.after.map((s: any) => [s.name, s.arrival, s.departure, s.status])).toEqual([
      ['Paris', '2027-01-12', '2027-01-15', 'kept'],
      ['London', '2027-01-15', '2027-01-18', 'moved'],
    ]);
    // Live: the date-only card had no price, and the page then swapped the
    // flight home after Accept (+$4 the user was never shown).
    expect(p.returnLeg).toMatchObject({ operator: 'American Airlines', departDate: '2027-01-18', price: 440.5 });
    expect(p.outboundLeg).toBeUndefined();
    expect(p.legs).toEqual([]);
    expect(p.constraints.min_days).toEqual([{ city: 'London', minNights: 3 }]);
    expect(res.body.reply).toBe(
      'Giving you three nights in London. New dates: London Jan 15–Jan 18 (3 nights). Your flight home moves to Jan 18. Accept to apply it.',
    );
  });
});

describe('review fixes', () => {
  it('finds the evening flight home even when 50 cheaper daytime fares come first (no cap before the filter)', async () => {
    const cheap = Array.from({ length: 50 }, (_, i) =>
      offer('Delta', 'DL', 300 + i, '2027-01-17', `${String(8 + (i % 8)).padStart(2, '0')}:${String(i).padStart(2, '0')}`, '15:00'));
    searchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      const k = `${origin}|${destination}|${date}`;
      if (k === 'LON|JFK|2027-01-17') return [...cheap, offer('British Airways', 'BA', 510.4, '2027-01-17', '19:25', '22:31')];
      return [];
    });
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', relative: 'later', timeOfDay: 'evening' });
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.after).toMatchObject({ operator: 'British Airways', departTime: '19:25', price: 510.4 });
  });

  it('an option id from another leg never selects the same-numbered option on this leg', async () => {
    const res = await chat(app, 'select_transport_option', { leg: 'Paris→London', optionId: 'London→home#2' });
    expect(res.body.type).toBe('answer');
    expect(res.body.proposal).toBeUndefined();
  });

  it('says "an evening flight" when there is none (live run: Paris → New York has nothing after 15:00)', async () => {
    searchFlights.mockImplementation(async ({ origin, destination, date }: any) =>
      origin === 'LON' && destination === 'JFK' && date === '2027-01-17' ? [offer('Iberia', 'IB', 438.66, '2027-01-17', '15:00', '18:00')] : []);
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', timeOfDay: 'evening', list: true });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('none is an evening flight');
  });

  it('lists one row per flight, at its cheapest fare', async () => {
    searchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      const k = `${origin}|${destination}|${date}`;
      if (k === 'LON|JFK|2027-01-17') return [
        offer('British Airways', 'BA', 560, '2027-01-17', '19:25', '22:31'),
        offer('British Airways', 'BA', 510.4, '2027-01-17', '19:25', '22:31'),
      ];
      return [];
    });
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', timeOfDay: 'evening', list: true });
    expect(res.body.type).toBe('leg_options');
    expect(res.body.legOptions.options.map((o: any) => `${o.operator} ${o.departTime} ${o.price}`)).toEqual(['British Airways 19:25 510.4']);
  });
});

describe('per-person view: the reply quotes amounts as the card and header show them', () => {
  const ask = (input: any, priceMode?: string) => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 'find_transport_option', input }] });
    return request(app).post('/api/plan/chat').send({ message: 'x', currentTrip: trip(), priceMode });
  };

  it('a proposal: per-person fares and the per-person header move (2 travellers)', async () => {
    const res = await ask({ leg: 'London→home', relative: 'later', timeOfDay: 'evening' }, 'perPerson');
    expect(res.body.type).toBe('proposal');
    // Party: $455.10 vs $432.18, total $1,576 → $1,599. Per person, rounded
    // as the header rounds: $228 vs $216, $788 → $800, so +$12 (not +$23).
    expect(res.body.reply).toContain('$228 per person instead of American Airlines LON 12:23 → JFK 15:24 at $216.');
    expect(res.body.reply).toContain('Trip total per person $788 → $800 (+$12).');
    // The proposal itself stays in party amounts (the card converts it).
    expect(res.body.proposal.totals).toEqual({ before: 1576, after: 1599, delta: 23 });
    expect(mockCreate.mock.calls[0][0].system).toContain('PER-PERSON');
  });

  it('a listing: per-person prices and differences', async () => {
    const res = await ask({ leg: 'London→home', timeOfDay: 'evening', list: true }, 'perPerson');
    expect(res.body.reply).toContain('1. Virgin Atlantic LON 18:05 → EWR 21:15 — $228 (+$12)');
  });

  it('total view (and no priceMode) is unchanged', async () => {
    const res = await ask({ leg: 'London→home', relative: 'later', timeOfDay: 'evening' });
    expect(res.body.reply).toContain('Trip total $1,576 → $1,599 (+$23)');
    expect(res.body.reply).not.toContain('per person');
    expect(mockCreate.mock.calls[0][0].system).not.toContain('PER-PERSON');
  });
});

describe('"cheaper" and "later" on the other legs', () => {
  it('"cheaper flight home" → the cheapest flight under $432 (Delta from LaGuardia), priced', async () => {
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', cheaper: true });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.after).toMatchObject({ operator: 'Delta', departTime: '07:10', toAirport: 'LGA', price: 399 });
    expect(p.priceDelta).toBe(-33.18);
    expect(p.totals).toEqual({ before: 1576, after: 1543, delta: -33 });
    expect(res.body.reply).toMatch(/^A cheaper flight home \(London → New York\): Delta LON 07:10 → LGA 10:05/);
    expect(res.body.reply).toContain('(−$33)');
  });

  it('"later flight out of New York" → the cheapest later one; it lands next day, so Paris loses a night, and the total says so', async () => {
    const res = await chat(app, 'find_transport_option', { leg: 'home→Paris', relative: 'later' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.leg).toMatchObject({ id: 'home→Paris', kind: 'outbound' });
    // Later than 08:30: UA 10:15 $480, AF 18:30 $470, DL 21:15 $462.
    expect(p.after).toMatchObject({ operator: 'Delta', departTime: '21:15', departDate: '2027-01-12', arriveDate: '2027-01-13', fromAirport: 'JFK', price: 462 });
    expect(p.priceDelta).toBe(12.24);
    expect(p.firstStay).toEqual({
      city: 'Paris', arrivalBefore: '2027-01-12', arrivalAfter: '2027-01-13', nightsBefore: 3, nightsAfter: 2, hotelDelta: -131.57,
    });
    // 1575.69 + 12.24 − 131.57 = 1456.36
    expect(p.totals).toEqual({ before: 1576, after: 1456, delta: -120 });
    expect(res.body.reply).toContain('Paris starts Jan 13: 2 nights instead of 3');
    expect(searchedRoutes()).toEqual(['EWR|PAR|2027-01-12', 'JFK|PAR|2027-01-12', 'LGA|PAR|2027-01-12']);
  });

  it('inter-city "Paris → London, later" → the cheapest later departure, as a proposal', async () => {
    const res = await chat(app, 'find_transport_option', { leg: 'Paris→London', relative: 'later' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.leg).toMatchObject({ id: 'Paris→London', kind: 'intercity', index: 0 });
    expect(p.after).toMatchObject({ mode: 'flight', operator: 'Air France', departTime: '14:05', price: 95.1 });
    expect(p.priceDelta).toBe(15.26);
    expect(p.totals).toEqual({ before: 1576, after: 1591, delta: 15 });
  });

  it('accepts the leg as "Paris to London" and as from/to', async () => {
    const a = await chat(app, 'find_transport_option', { leg: 'Paris to London', relative: 'later' });
    expect(a.body.proposal.leg.id).toBe('Paris→London');
    const b = await chat(app, 'find_transport_option', { leg: 'JFK->Paris', relative: 'later' });
    expect(b.body.proposal.leg.id).toBe('home→Paris');
  });
});

describe('vague and impossible requests', () => {
  it('"change my flight" → asks which leg, naming every leg including both home flights', async () => {
    const res = await chat(app, 'ask_which_leg', {});
    expect(res.body).toEqual({
      type: 'answer',
      reply: 'Which one — New York → Paris (Jan 12), Paris → London (Jan 15) or London → New York (Jan 17)?',
    });
  });

  it('a leg tool called with no leg asks the same instead of guessing, and searches nothing', async () => {
    const res = await chat(app, 'find_transport_option', { relative: 'later' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('London → New York (Jan 17)');
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('a request nothing satisfies says so plainly and proposes nothing', async () => {
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', departAfter: '23:00' });
    expect(res.body.type).toBe('answer');
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.reply).toBe(
      'I searched 8 options for London → New York on Jan 17 and none is a flight departing after 23:00 (the latest leaves at 20:40). Nothing changed — want me to try a different time or day?',
    );
  });

  it('a "cheaper" ask when nothing is cheaper says so', async () => {
    const t = trip();
    t.origin.returnLeg.price = 350;
    t.totalCost = headerTotal(t);
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', cheaper: true }, t);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('the cheapest other flight is $399, you have $350');
  });

  it('a "cheaper" ask when only the same flight re-prices lower: no contradiction (live: "the cheapest is $223, you have $225")', async () => {
    searchFlights.mockImplementation(async ({ origin, destination, date }: any) =>
      origin === 'LON' && destination === 'JFK' && date === '2027-01-17'
        ? [offer('American Airlines', 'AA', 428.5, '2027-01-17', '12:23', '15:24'), offer('Iberia', 'IB', 438.66, '2027-01-17', '12:23', '15:24')]
        : []);
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', cheaper: true });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('the cheapest other flight is $439, you have $432; your own flight now shows $429');
    expect(res.body.reply).not.toContain('the cheapest is');
  });

  it('names the real legs — home ones included — for a pair that is not a leg', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'London', to: 'Paris', explanation: 'x' });
    expect(res.body).toEqual({
      type: 'answer',
      reply: "London → Paris isn't a leg of this trip — its legs are New York → Paris, Paris → London and London → New York. Which one did you mean?",
    });
  });

  it('compare_modes on a home leg says home legs are flights only, and compares nothing', async () => {
    const res = await chat(app, 'compare_modes', { leg: 'London→home', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('only search flights to and from home');
    expect(mockCompareLeg).not.toHaveBeenCalled();
  });

  it('a train with no fare is not proposed (it would read as a −$80 saving)', async () => {
    // Rail answers Paris → London with a Eurostar no provider priced.
    require('../services/trains').searchTrains.mockResolvedValueOnce([
      {
        id: 'trn_1', price: null, currency: 'USD', departure: '2027-01-15T13:01:00', arrival: '2027-01-15T14:30:00',
        durationMinutes: 149, operator: 'Eurostar', trainType: 'high-speed', bookingUrl: null, limitedCoverage: true,
      },
    ]);
    const res = await chat(app, 'find_transport_option', { leg: 'Paris→London', mode: 'train' });
    expect(res.body.type).toBe('answer');
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.reply).toBe("Eurostar train 13:01 → 14:30 on Jan 15 has no fare I can price, so I haven't proposed it — nothing changed.");
  });

  it('an unreadable time is refused, not dropped', async () => {
    const res = await chat(app, 'find_transport_option', { leg: 'London→home', departAfter: 'evening-ish' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('"evening-ish"');
    expect(searchFlights).not.toHaveBeenCalled();
  });
});

describe('Reject, and what the server claims', () => {
  it('after a Reject the next turn sees the trip exactly as before (the server applied nothing)', async () => {
    const t = trip();
    const first = await chat(app, 'select_transport_option', { leg: 'London→home', optionId: 'London→home#1' }, t);
    expect(first.body.type).toBe('proposal');
    // The client sends the unchanged trip with the rejection noted in history.
    await chat(app, 'answer_only', { answer: 'ok' }, t, 'never mind', [
      { role: 'user', content: 'switch my flight home to the British Airways one' },
      { role: 'assistant', content: `${first.body.reply} [The user REJECTED this change; the trip is unchanged.]` },
    ]);
    const system: string = mockCreate.mock.calls[1][0].system;
    expect(system).toContain('"optionId": "London→home#0"');
    expect(system).toContain('"depart": "LON 12:23 2027-01-17"');
    expect(t).toEqual(trip());
  });

  it('claims no trip total when the trip\'s total is not the header\'s (states the fare change only)', async () => {
    const t = trip();
    t.totalCost = 9999;
    const res = await chat(app, 'select_transport_option', { leg: 'London→home', optionId: 'London→home#1' }, t);
    expect(res.body.proposal.totals).toBeNull();
    expect(res.body.reply).toContain('The fare changes by +$3.');
    expect(res.body.reply).not.toContain('Trip total');
  });

  it('verification rejects a proposal that is not the asked-for option or whose total does not add up', () => {
    const legs = tripLegs(trip());
    const ret = legs[2];
    const good = {
      kind: 'transport_change' as const,
      toolName: 'select_transport_option',
      leg: ret,
      before: ret.current,
      after: ret.options[1],
      request: { optionId: 'London→home#1' },
      priceDelta: 3.18,
      firstStay: null,
      totals: { before: 1576, after: 1579, delta: 3 },
    };
    expect(verifyTransportProposal(good, ret)).toEqual([]);
    expect(verifyTransportProposal({ ...good, after: ret.options[2] }, ret).length).toBeGreaterThan(0);
    expect(verifyTransportProposal({ ...good, totals: { before: 1576, after: 1600, delta: 24 } }, ret)).toContain(
      'total change does not match the fare and stay changes',
    );
    expect(verifyTransportProposal({ ...good, after: ret.current!, request: {} }, ret)).toContain('the proposed option is the current one');
    expect(
      verifyTransportProposal({ ...good, request: { window: { earliestDepart: '17:00', latestDepart: null, earliestArrive: null, latestArrive: null } } } as any, ret),
    ).toContain('not departing after 17:00');
  });
});

describe('the service seam', () => {
  it('runTripChat returns the same result the route sends', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 'ask_which_leg', input: {} }] });
    const out = await runTripChat({ message: 'change my flight', currentTrip: trip() });
    expect(out).toEqual({
      type: 'answer',
      reply: 'Which one — New York → Paris (Jan 12), Paris → London (Jan 15) or London → New York (Jan 17)?',
    });
  });
});
