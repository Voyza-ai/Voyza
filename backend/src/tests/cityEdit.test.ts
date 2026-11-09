/**
 * AI chat city edits — add_city, remove_city, replace_city on /api/plan/chat.
 *
 * The model is scripted (mocked Anthropic returns the tool_use under test);
 * the hotel, leg and home-flight searches are faked so each test can see
 * exactly WHAT was re-priced. The planner (planCityEdit) and the location
 * check (checkCityName, real checked-in index) are real.
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
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { planCityEdit, checkCityName, cityEditOpFromTool } from '../services/cityEdit';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);
  return app;
}

const leg = (from: string, to: string, price: number) => ({ mode: 'train', operator: 'X', duration: '2h', price, from, to });
const homeLeg = (dest: string, date: string, price: number, extra: any = {}) => ({
  originAirport: 'JFK', destAirport: dest.slice(0, 3).toUpperCase(), price, currency: 'USD', durationMinutes: 500,
  operator: 'Air', carrierCode: 'AA', departTime: '10:00', arriveTime: '22:00', departDate: date, stops: 0, bookingUrl: null, ...extra,
});

/** JFK → Rome → Florence → Venice → JFK, two nights each, Dec 2026. */
const baseTrip = () => ({
  title: 'Rome → Florence → Venice',
  travelers: 2,
  returnToHome: true,
  origin: {
    city: 'New York',
    airports: ['JFK'],
    outboundLeg: homeLeg('Rome', '2026-12-08', 600),
    returnLeg: homeLeg('Venice', '2026-12-14', 550),
  },
  cities: [
    { name: 'Rome', country: 'Italy', dates: { arrival: '2026-12-08', departure: '2026-12-10' }, transportOut: leg('Rome', 'Florence', 40) },
    { name: 'Florence', country: 'Italy', dates: { arrival: '2026-12-10', departure: '2026-12-12' }, transportIn: leg('Rome', 'Florence', 40), transportOut: leg('Florence', 'Venice', 30) },
    { name: 'Venice', country: 'Italy', dates: { arrival: '2026-12-12', departure: '2026-12-14' }, transportIn: leg('Florence', 'Venice', 30) },
  ],
});
const stops = () => baseTrip().cities.map((c) => ({ name: c.name, ...c.dates }));

const hotel = (city: string, ppn: number) => ({
  id: city, name: `${city} Inn`, price: ppn * 2, pricePerNight: ppn, currency: 'USD', rating: 8.5, reviewCount: 300,
  stars: 3, thumbnail: '', bookingUrl: 'https://booking.test', amenities: [],
});
const option = (price: number) => ({
  mode: 'train', operator: 'Trenitalia', flightNumber: null, price, currency: 'USD', departTime: '09:00', arriveTime: '11:00',
  duration: '2h', durationMinutes: 120, priceDelta: 0, bookingUrl: null,
});

async function chat(app: express.Express, name: string, input: any, trip: any = baseTrip()) {
  mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name, input }] });
  return request(app).post('/api/plan/chat').send({ message: 'x', currentTrip: trip });
}

const FROZEN_NOW = '2026-10-30T15:00:00Z';
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
  mockSearchHotels.mockImplementation(async ({ city }: any) => [hotel(city, 120)]);
  mockSearchLegOptions.mockImplementation(async () => ({ options: [option(45)], hasMatches: true, windowFilteredAll: false }));
  mockBuildHomeLeg.mockImplementation(async ({ destinationCity, date }: any) => homeLeg(destinationCity, date, 700));
});

describe('planCityEdit — dates and what has to be re-priced', () => {
  it('replace keeps the old dates and re-prices only the two touching legs and one hotel', () => {
    const r = planCityEdit(stops(), { kind: 'replace', oldCity: 'Florence', newCity: 'Bologna' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after.map((s) => [s.name, s.arrival, s.departure, s.status])).toEqual([
      ['Rome', '2026-12-08', '2026-12-10', 'kept'],
      ['Bologna', '2026-12-10', '2026-12-12', 'replaced'],
      ['Venice', '2026-12-12', '2026-12-14', 'kept'],
    ]);
    expect(r.plan.hotels).toEqual([1]);
    expect(r.plan.legs).toEqual([0, 1]);
    expect(r.plan.outbound).toBe(false);
    expect(r.plan.ret).toBe(false);
  });

  it('remove gives the nights to the previous city, so the trip ends on the same day', () => {
    const r = planCityEdit(stops(), { kind: 'remove', city: 'florence' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after.map((s) => [s.name, s.arrival, s.departure])).toEqual([
      ['Rome', '2026-12-08', '2026-12-12'],
      ['Venice', '2026-12-12', '2026-12-14'],
    ]);
    expect(r.plan.hotels).toEqual([0]);
    expect(r.plan.legs).toEqual([0]);
    expect(r.plan.removed).toEqual(['Florence']);
    expect(r.plan.note).toContain("Rome keeps Florence's 2 nights");
  });

  it('removing the first city gives its nights to the next and re-searches the outbound', () => {
    const r = planCityEdit(stops(), { kind: 'remove', city: 'Rome' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after[0]).toMatchObject({ name: 'Florence', arrival: '2026-12-08', departure: '2026-12-12' });
    expect(r.plan.outbound).toBe(true);
    expect(r.plan.legs).toEqual([]);
  });

  it('removing the last city re-searches the flight home from the new last city', () => {
    const r = planCityEdit(stops(), { kind: 'remove', city: 'Venice' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after[1]).toMatchObject({ name: 'Florence', departure: '2026-12-14' });
    expect(r.plan.ret).toBe(true);
  });

  it('refuses to remove the only city', () => {
    const r = planCityEdit([{ name: 'Rome', arrival: '2026-12-08', departure: '2026-12-10' }], { kind: 'remove', city: 'Rome' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/only city/);
  });

  it('add after a middle city shifts later cities and re-prices everything that moved', () => {
    const r = planCityEdit(stops(), { kind: 'add', city: 'Bologna', afterCity: 'Rome', nights: 3 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after.map((s) => [s.name, s.arrival, s.departure, s.status])).toEqual([
      ['Rome', '2026-12-08', '2026-12-10', 'kept'],
      ['Bologna', '2026-12-10', '2026-12-13', 'added'],
      ['Florence', '2026-12-13', '2026-12-15', 'moved'],
      ['Venice', '2026-12-15', '2026-12-17', 'moved'],
    ]);
    expect(r.plan.hotels).toEqual([1, 2, 3]);
    expect(r.plan.legs).toEqual([0, 1, 2]);
    expect(r.plan.ret).toBe(true);
  });

  it('add before the FIRST city opens the trip: everything moves later and the flight from home is re-priced', () => {
    const r = planCityEdit(stops(), { kind: 'add', city: 'Naples', beforeCity: 'rome' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after.map((s) => [s.name, s.arrival, s.departure, s.status])).toEqual([
      ['Naples', '2026-12-08', '2026-12-10', 'added'],
      ['Rome', '2026-12-10', '2026-12-12', 'moved'],
      ['Florence', '2026-12-12', '2026-12-14', 'moved'],
      ['Venice', '2026-12-14', '2026-12-16', 'moved'],
    ]);
    expect(r.plan.hotels).toEqual([0, 1, 2, 3]);
    expect(r.plan.legs).toEqual([0, 1, 2]);
    expect(r.plan.outbound).toBe(true);
    expect(r.plan.ret).toBe(true);
    expect(r.plan.note).toMatch(/Naples opens the trip/);
  });

  it('add before a middle city is the same as after the one before it', () => {
    const before = planCityEdit(stops(), { kind: 'add', city: 'Bologna', beforeCity: 'Florence', nights: 3 });
    const after = planCityEdit(stops(), { kind: 'add', city: 'Bologna', afterCity: 'Rome', nights: 3 });
    expect(before).toEqual(after);
  });

  it('add before a single-city trip', () => {
    const r = planCityEdit([{ name: 'Florence', arrival: '2026-12-10', departure: '2026-12-16' }], { kind: 'add', city: 'Rome', beforeCity: 'Florence' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after.map((s) => s.name)).toEqual(['Rome', 'Florence']);
    expect(r.plan.after[1]).toMatchObject({ arrival: '2026-12-12', departure: '2026-12-18' });
    expect(r.plan.outbound).toBe(true);
  });

  it('add with no afterCity goes at the end with 2 nights', () => {
    const r = planCityEdit(stops(), { kind: 'add', city: 'Milan' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after[3]).toMatchObject({ name: 'Milan', arrival: '2026-12-14', departure: '2026-12-16' });
    expect(r.plan.legs).toEqual([2]);
    expect(r.plan.hotels).toEqual([3]);
  });

  it.each([
    [{ kind: 'add', city: 'Rome' }, /already in this trip/],
    [{ kind: 'add', city: 'Milan', afterCity: 'Paris' }, /Paris isn't in this trip/],
    [{ kind: 'add', city: 'Milan', beforeCity: 'Paris' }, /Paris isn't in this trip/],
    [{ kind: 'add', city: 'Milan', nights: 0 }, /whole number of nights/],
    [{ kind: 'remove', city: 'Paris' }, /Paris isn't in this trip/],
    [{ kind: 'replace', oldCity: 'Paris', newCity: 'Lyon' }, /Paris isn't in this trip/],
    [{ kind: 'replace', oldCity: 'Rome', newCity: 'Venice' }, /already in this trip/],
  ])('refuses %j', (op, why) => {
    const r = planCityEdit(stops(), op as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(why);
  });
});

describe('checkCityName', () => {
  it('accepts a real city', () => expect(checkCityName('Bologna', ['Rome'])).toEqual({ ok: true }));
  it('refuses a country', () => {
    const r = checkCityName('Venezuela', ['Rome']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reply).toMatch(/country/);
  });
  it('answers a near miss with "did you mean"', () => {
    const r = checkCityName('Barcelonaa', ['Rome']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reply).toMatch(/Did you mean Barcelona/);
  });
  it('accepts a name several cities share (the searches use trip context)', () => {
    expect(checkCityName('Springfield', [])).toEqual({ ok: true });
    expect(checkCityName('Venice', ['Caracas'])).toEqual({ ok: true });
  });
});

describe('cityEditOpFromTool', () => {
  it('maps each tool and rejects a missing city', () => {
    expect(cityEditOpFromTool('add_city', { city: 'Nice', afterCity: 'Rome' })).toEqual({ kind: 'add', city: 'Nice', afterCity: 'Rome', beforeCity: null, nights: null });
    expect(cityEditOpFromTool('add_city', { city: 'Nice', beforeCity: 'Rome' })).toEqual({ kind: 'add', city: 'Nice', afterCity: null, beforeCity: 'Rome', nights: null });
    expect(cityEditOpFromTool('remove_city', { city: 'Nice' })).toEqual({ kind: 'remove', city: 'Nice' });
    expect(cityEditOpFromTool('replace_city', { old: 'Rome', new: 'Naples' })).toEqual({ kind: 'replace', oldCity: 'Rome', newCity: 'Naples' });
    expect(cityEditOpFromTool('replace_city', { old: 'Rome' })).toBeNull();
    expect(cityEditOpFromTool('add_city', { city: '  ' })).toBeNull();
  });
});

describe('POST /api/plan/chat — city edit tools', () => {
  const app = createApp();

  it('add_city returns a priced proposal and searches only what changed', async () => {
    const res = await chat(app, 'add_city', { city: 'Bologna', afterCity: 'Florence', explanation: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.kind).toBe('city_edit');
    expect(p.toolName).toBe('add_city');
    expect(p.after.map((s: any) => s.name)).toEqual(['Rome', 'Florence', 'Bologna', 'Venice']);
    expect(p.after[2].hotels[0].name).toBe('Bologna Inn');
    // Hotels: Bologna (new) and Venice (moved). Rome/Florence untouched.
    expect(mockSearchHotels.mock.calls.map((c) => c[0].city).sort()).toEqual(['Bologna', 'Venice']);
    expect(mockSearchHotels.mock.calls.find((c) => c[0].city === 'Venice')[0]).toMatchObject({ checkin: '2026-12-14', checkout: '2026-12-16', adults: 2 });
    // Legs: Florence → Bologna and Bologna → Venice.
    expect(p.legs.map((l: any) => `${l.from}>${l.to}@${l.date}`)).toEqual([
      'Florence>Bologna@2026-12-12',
      'Bologna>Venice@2026-12-14',
    ]);
    // The return now leaves Venice two days later; the outbound is untouched.
    expect(mockBuildHomeLeg).toHaveBeenCalledTimes(1);
    expect(mockBuildHomeLeg.mock.calls[0][0]).toMatchObject({ destinationCity: 'Venice', date: '2026-12-16', reverse: true });
    expect(p.returnLeg.departDate).toBe('2026-12-16');
    expect(p.outboundLeg).toBeUndefined();
    expect(res.body.reply).toContain('Bologna added after Florence');
    // The model wrote nothing that reached the reply.
    expect(res.body.reply).not.toContain('x.');
  });

  it('remove_city proposes the shorter trip with the new leg priced', async () => {
    const res = await chat(app, 'remove_city', { city: 'Florence', explanation: 'x' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.after.map((s: any) => [s.name, s.arrival, s.departure])).toEqual([
      ['Rome', '2026-12-08', '2026-12-12'],
      ['Venice', '2026-12-12', '2026-12-14'],
    ]);
    expect(p.removed).toEqual(['Florence']);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]).toMatchObject({ from: 'Rome', to: 'Venice', date: '2026-12-12' });
    expect(mockBuildHomeLeg).not.toHaveBeenCalled();
    expect(res.body.reply).toContain('without Florence');
  });

  it('replace_city of the first city re-searches the outbound and dates the stay by its landing', async () => {
    mockBuildHomeLeg.mockImplementationOnce(async ({ destinationCity, date }: any) =>
      homeLeg(destinationCity, date, 650, { arriveDate: '2026-12-09' }),
    );
    const res = await chat(app, 'replace_city', { old: 'Rome', new: 'Naples', explanation: 'x' });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.after[0]).toMatchObject({ name: 'Naples', status: 'replaced', replaces: 'Rome', arrival: '2026-12-09', departure: '2026-12-10' });
    expect(mockBuildHomeLeg.mock.calls[0][0]).toMatchObject({ destinationCity: 'Naples', date: '2026-12-08' });
    expect(p.outboundLeg.price).toBe(650);
    expect(p.legs.map((l: any) => `${l.from}>${l.to}`)).toEqual(['Naples>Florence']);
  });

  it('removing the last city answers instead of proposing', async () => {
    const trip: any = baseTrip();
    trip.cities = [trip.cities[0]];
    const res = await chat(app, 'remove_city', { city: 'Rome', explanation: 'x' }, trip);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toMatch(/only city/);
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });

  it('replacing with a country answers with a question and searches nothing', async () => {
    const res = await chat(app, 'replace_city', { old: 'Florence', new: 'Venezuela', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toMatch(/country/);
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });

  it('replacing with a misspelling answers "did you mean"', async () => {
    const res = await chat(app, 'replace_city', { old: 'Florence', new: 'Barcelonaa', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toMatch(/Did you mean Barcelona/);
  });

  it('an unknown name nothing can be found for is refused after the search', async () => {
    mockSearchHotels.mockResolvedValue([]);
    mockSearchLegOptions.mockResolvedValue({ options: [], hasMatches: false, windowFilteredAll: false });
    const res = await chat(app, 'replace_city', { old: 'Florence', new: 'Qwxzplor', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toMatch(/no hotels in Qwxzplor/);
  });

  it('a city not in the trip is refused with the trip\'s cities named', async () => {
    const res = await chat(app, 'remove_city', { city: 'Paris', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain("Paris isn't in this trip (it has Rome, Florence, Venice)");
  });

  it('a failed hotel search still proposes, with an empty hotel list', async () => {
    mockSearchHotels.mockRejectedValue(new Error('booking down'));
    const res = await chat(app, 'replace_city', { old: 'Florence', new: 'Bologna', explanation: 'x' });
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.after[1].hotels).toEqual([]);
  });
});
