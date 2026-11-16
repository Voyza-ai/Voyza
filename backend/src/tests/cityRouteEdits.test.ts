/**
 * City edits with geographic common sense, a reorder tool, and no silent
 * 22-hour legs — on the owner's production trip: Prague → Munich → Vienna,
 * Dec 23–31 2026, 2 travellers, home New York.
 *
 * Production: "add another city of your choice, I'm feeling Christmas vibes"
 * put Salzburg right after Prague (CZ → AT → DE → AT: leaving Austria and
 * coming back), priced Prague → Salzburg as a 22h 30m flight, and "reorder"
 * was answered "I can't directly reorder cities with the tools I have".
 *
 * Scaffolding (mocks) as in cityEdit.test.ts; the model is scripted, the
 * location index, planning and pricing are real.
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
    RAPIDAPI_KEY: 'test_key',
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

const mockSearchHotels = jest.fn();
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: (p: any) => mockSearchHotels(p),
}));

const mockSearchLegOptions = jest.fn();
jest.mock('../services/legOptions', () => ({
  ...jest.requireActual('../services/legOptions'),
  searchLegOptions: (p: any) => mockSearchLegOptions(p),
}));

const mockBuildHomeLeg = jest.fn();
jest.mock('../services/optimizer', () => ({
  ...jest.requireActual('../services/optimizer'),
  buildHomeLeg: (p: any) => mockBuildHomeLeg(p),
  // City edits pick from every home-flight option (services/legPreference.ts):
  // the same flights, main first.
  searchHomeLegOptions: async (p: any) => {
    const l = await mockBuildHomeLeg(p);
    if (!l) return [];
    const { alternatives, ...main } = l;
    return [main, ...(alternatives ?? [])];
  },
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);
  return app;
}
const app = createApp();

const homeLeg = (dest: string, date: string, price: number, extra: any = {}) => ({
  originAirport: 'JFK', destAirport: dest.slice(0, 3).toUpperCase(), price, currency: 'USD', durationMinutes: 600,
  operator: 'Air', carrierCode: 'AA', departTime: '10:00', arriveTime: '22:00', departDate: date, stops: 0, bookingUrl: null, ...extra,
});
const flight = (from: string, to: string, price: number, extra: any = {}) => ({ mode: 'flight', operator: 'Air', duration: '1h', price, from, to, ...extra });
const city = (name: string, country: string, arrival: string, departure: string, out: any = null) => ({
  name, country, dates: { arrival, departure }, ...(out ? { transportOut: out } : {}),
});

/** Prague 3n → Munich 2n → Vienna 3n, Dec 23–31 2026, home New York (flight home VIE → JFK). */
const ownerTrip = (): any => ({
  title: 'Prague → Munich → Vienna',
  travelers: 2,
  returnToHome: true,
  origin: { city: 'New York', airports: ['JFK'], outboundLeg: homeLeg('Prague', '2026-12-23', 900), returnLeg: homeLeg('Vienna', '2026-12-31', 800) },
  cities: [
    city('Prague', 'Czech Republic', '2026-12-23', '2026-12-26', flight('Prague', 'Munich', 120)),
    city('Munich', 'Germany', '2026-12-26', '2026-12-28', flight('Munich', 'Vienna', 110)),
    city('Vienna', 'Austria', '2026-12-28', '2026-12-31'),
  ],
});
/** The trip after production's add: Prague → Salzburg → Munich → Vienna. */
const backtrackTrip = (): any => {
  const t = ownerTrip();
  t.cities = [
    city('Prague', 'Czech Republic', '2026-12-23', '2026-12-26', flight('Prague', 'Salzburg', 174)),
    city('Salzburg', 'Austria', '2026-12-26', '2026-12-28', flight('Salzburg', 'Munich', 90)),
    city('Munich', 'Germany', '2026-12-28', '2026-12-30', flight('Munich', 'Vienna', 110)),
    city('Vienna', 'Austria', '2026-12-30', '2027-01-02'),
  ];
  t.origin.returnLeg = homeLeg('Vienna', '2027-01-02', 800);
  return t;
};

const option = (price: number, extra: any = {}) => ({
  mode: 'flight', operator: 'Air', flightNumber: null, price, currency: 'USD', departTime: '09:00', arriveTime: '10:15',
  duration: '1h 15m', durationMinutes: 75, stops: 0, priceDelta: 0, bookingUrl: null, ...extra,
});

async function chat(name: string, input: any, trip: any = ownerTrip()) {
  mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name, input }] });
  return request(app).post('/api/plan/chat').send({ message: 'x', currentTrip: trip });
}

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-16T12:00:00Z'),
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
  mockSearchHotels.mockImplementation(async () => []);
  mockSearchLegOptions.mockImplementation(async () => ({ options: [option(100)], hasMatches: true, windowFilteredAll: false }));
  mockBuildHomeLeg.mockImplementation(async ({ destinationCity, date }: any) => homeLeg(destinationCity, date, 820));
});

const order = (p: any) => p.after.map((s: any) => s.name);

describe('adding a city puts it where it adds the least detour', () => {
  it('"a city of your choice" (Salzburg): between Munich and Vienna, not after Prague, and says why', async () => {
    // The model chose the slot itself (production): it is not the user's.
    const res = await chat('add_city', { city: 'Salzburg', afterCity: 'Prague', userSaidWhere: false, explanation: 'x' });
    expect(res.body.type).toBe('proposal');
    expect(order(res.body.proposal)).toEqual(['Prague', 'Munich', 'Salzburg', 'Vienna']);
    expect(res.body.reply).toContain('I put Salzburg between Munich and Vienna, so you stay in Austria without leaving and coming back.');
  });

  it('a position the user named is obeyed, with a one-line warning when it backtracks', async () => {
    const res = await chat('add_city', { city: 'Salzburg', afterCity: 'Prague', userSaidWhere: true, explanation: 'x' });
    expect(order(res.body.proposal)).toEqual(['Prague', 'Salzburg', 'Munich', 'Vienna']);
    expect(res.body.reply).toContain('Heads-up: there it leaves Austria and comes back; between Munich and Vienna would avoid that.');
  });
});

describe('reorder_cities', () => {
  it('"swap Munich and Vienna": the new order, nights kept, the changed legs and the flight home re-priced', async () => {
    const res = await chat('reorder_cities', { order: ['Prague', 'Vienna', 'Munich'], explanation: 'x' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p).toMatchObject({ kind: 'city_edit', toolName: 'reorder_cities', op: { kind: 'reorder' } });
    expect(p.after.map((s: any) => [s.name, s.arrival, s.departure, s.status])).toEqual([
      ['Prague', '2026-12-23', '2026-12-26', 'kept'],
      ['Vienna', '2026-12-26', '2026-12-29', 'moved'],
      ['Munich', '2026-12-29', '2026-12-31', 'moved'],
    ]);
    expect(p.legs.map((l: any) => `${l.from}→${l.to} ${l.date}`)).toEqual(['Prague→Vienna 2026-12-26', 'Vienna→Munich 2026-12-29']);
    // The flight home now leaves Munich.
    expect(p.returnLeg).toMatchObject({ departDate: '2026-12-31', price: 820 });
    expect(mockBuildHomeLeg.mock.calls.some((c) => c[0].destinationCity === 'Munich')).toBe(true);
    expect(p.outboundLeg).toBeUndefined();
    expect(res.body.reply).toMatch(/^Here's your trip as Prague → Vienna → Munich\. New order: Prague \(3 nights\) → Vienna \(3 nights\) → Munich \(2 nights\)\./);
  });

  it('"put the Austrian cities together" on Prague → Salzburg → Munich → Vienna', async () => {
    const res = await chat('reorder_cities', { order: ['Prague', 'Munich', 'Salzburg', 'Vienna'], explanation: 'x' }, backtrackTrip());
    expect(order(res.body.proposal)).toEqual(['Prague', 'Munich', 'Salzburg', 'Vienna']);
    expect(res.body.proposal.after.map((s: any) => s.status)).toEqual(['kept', 'moved', 'moved', 'kept']);
  });

  it('"what\'s the best order?": no leaving a country and coming back, the least travel, and says so', async () => {
    const res = await chat('reorder_cities', { optimize: true, explanation: 'x' }, backtrackTrip());
    expect(res.body.type).toBe('proposal');
    const names = order(res.body.proposal);
    const at = names.map((n: string) => (n === 'Salzburg' || n === 'Vienna' ? 'AT' : n === 'Munich' ? 'DE' : 'CZ'));
    expect(at.filter((c: string, i: number) => i > 0 && c !== at[i - 1] && at.slice(0, i - 1).includes(c))).toEqual([]);
    expect(res.body.reply).toContain('stops leaving a country and coming back');
    expect(res.body.reply).toContain('the card shows the exact change in price');
  });

  it('an order that is already the best says so and proposes nothing', async () => {
    const first = await chat('reorder_cities', { optimize: true, explanation: 'x' }, backtrackTrip());
    const best = backtrackTrip();
    best.cities = first.body.proposal.after.map((s: any) => city(s.name, '', s.arrival, s.departure));
    const res = await chat('reorder_cities', { optimize: true, explanation: 'x' }, best);
    expect(res.body.type).toBe('answer');
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.reply).toBe(`${order(first.body.proposal).join(' → ')} is already the order with the least backtracking and travel, so I'd keep it.`);
  });

  it('refuses an order that drops or repeats a city', async () => {
    const res = await chat('reorder_cities', { order: ['Prague', 'Vienna', 'Vienna'], explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('has to name each of Prague, Munich, Vienna once');
  });
});

describe('a leg with no sensible flight is flagged, not silently priced', () => {
  it('Prague → Salzburg at 22h 30m with 2 stops: flagged on the card, a labelled ground estimate, no fake price', async () => {
    mockSearchLegOptions.mockImplementation(async ({ from, to }: any) =>
      from === 'Prague' && to === 'Salzburg'
        ? { options: [option(174, { operator: 'LOT', departTime: '10:25', arriveTime: '08:55', duration: '22h 30m', durationMinutes: 1350, stops: 2 })], hasMatches: true, windowFilteredAll: false }
        : { options: [option(100)], hasMatches: true, windowFilteredAll: false });
    const res = await chat('add_city', { city: 'Salzburg', afterCity: 'Prague', userSaidWhere: true, explanation: 'x' });
    const leg = res.body.proposal.legs.find((l: any) => l.from === 'Prague' && l.to === 'Salzburg');
    expect(leg.flag).toEqual({ fastestMinutes: 1350, stops: 2, groundHours: [4, 6] });
    expect(leg.options[0].price).toBe(174); // still priced
    expect(res.body.reply).toContain(
      'No sensible flight Prague → Salzburg (the fastest takes 22h 30m with 2 stops); this trip is usually made by train or bus — about 4–6h by ground (an estimate from the distance; no fare shown).',
    );
    // An ordinary hop is not flagged.
    expect(res.body.proposal.legs.find((l: any) => l.from === 'Salzburg').flag).toBeUndefined();
  });
});
