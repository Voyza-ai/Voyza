/**
 * POST /api/plan/chat — the AI chat's leg and date tools.
 *
 * The model is scripted: the mocked Anthropic client returns exactly the
 * tool_use under test, so these drive the real route, the real
 * constraints.ts and the real legOptions.ts. Only the flight/train
 * providers are faked.
 *
 * Every scenario here was reproduced against the unfixed route (B9, B10):
 * a non-leg "Rome → Florence" came back as a leg_refresh that the frontend
 * wrote over Rome's real Rome → Venice leg; a past pin moved the trip to
 * Dec 2024; "Dec 9" was stored as a date; minNights 400 pushed the trip to
 * 2028; "5pm" was silently ignored while the reply said "departing after
 * 5pm". In every case the route returned a proposal or refresh whose reply
 * claimed success. The rule these tests pin down: if a constraint can't be
 * applied, the route answers with a plain reply that says so, and nothing
 * is proposed.
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
const { searchFlights } = require('../services/flights');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);
  return app;
}

/** A Duffel-shaped offer departing at `dep` (HH:MM) on the leg's date. */
const offer = (price: number, dep: string, date = '2026-12-10') => ({
  id: `off_${price}`,
  price,
  currency: 'USD',
  departure: `${date}T${dep}:00`,
  arrival: `${date}T${dep.replace(/^(\d\d)/, (h) => String(Number(h) + 1).padStart(2, '0'))}:00`,
  durationMinutes: 65,
  stops: 0,
  carrier: 'Mock Air',
  carrierCode: 'MK',
  bookingUrl: 'https://example.test',
  raw: {},
});

const leg = (from: string, to: string, price: number) => ({
  mode: 'flight',
  operator: 'X',
  duration: '1h',
  price,
  from,
  to,
});

/** Rome → Venice → Florence, two nights each, in December 2026. */
const baseTrip = () => ({
  title: 'Rome → Venice → Florence',
  travelers: 2,
  cities: [
    { name: 'Rome', dates: { arrival: '2026-12-08', departure: '2026-12-10' }, transportIn: leg('JFK', 'Rome', 0), transportOut: leg('Rome', 'Venice', 110) },
    { name: 'Venice', dates: { arrival: '2026-12-10', departure: '2026-12-12' }, transportIn: leg('Rome', 'Venice', 110), transportOut: leg('Venice', 'Florence', 90) },
    { name: 'Florence', dates: { arrival: '2026-12-12', departure: '2026-12-14' }, transportIn: leg('Venice', 'Florence', 90), transportOut: leg('Florence', 'JFK', 0) },
  ],
  constraints: {},
});

/** The same trip with Rome pinned to Dec 8–12 and the rest chained after it. */
const romePinnedTrip = () => {
  const t: any = baseTrip();
  t.cities[0].dates = { arrival: '2026-12-08', departure: '2026-12-12' };
  t.cities[1].dates = { arrival: '2026-12-12', departure: '2026-12-14' };
  t.cities[2].dates = { arrival: '2026-12-14', departure: '2026-12-16' };
  t.constraints = { pinned_cities: [{ city: 'Rome', arrival: '2026-12-08', departure: '2026-12-12' }] };
  return t;
};

async function chat(app: express.Express, name: string, input: any, trip: any = baseTrip()) {
  mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name, input }] });
  return request(app).post('/api/plan/chat').send({ message: 'x', currentTrip: trip });
}

// "Today" is pinned so the fixture dates stay in the future forever. Only
// Date is faked: supertest and express need real timers and ticks.
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
  (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
  searchFlights.mockImplementation(async ({ origin, destination }: any) => {
    if (origin === 'ROM' && destination === 'VEN') return [offer(120, '07:15'), offer(110, '16:00')];
    if (origin === 'ROM' && destination === 'FLO') return [offer(140, '08:00'), offer(95, '18:30')];
    return [offer(200, '12:00')];
  });
});

describe('B9 — leg tools only act on legs in the trip order', () => {
  const app = createApp();

  it('refuses Rome → Florence on Rome → Venice → Florence and names the real legs', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'Rome', to: 'Florence', explanation: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('answer');
    expect(res.body.refresh).toBeUndefined();
    expect(res.body.reply).toContain('Rome → Florence');
    expect(res.body.reply).toContain('Rome → Venice');
    expect(res.body.reply).toContain('Venice → Florence');
    // Nothing was searched: the leg doesn't exist, so there is no date to price.
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('refuses the reverse direction (Florence → Rome), which used to overwrite Rome\'s inbound', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'Florence', to: 'Rome', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.refresh).toBeUndefined();
  });

  it('refuses the reverse of a real leg (Venice → Rome)', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'Venice', to: 'Rome', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('Rome → Venice');
  });

  it('applies the same rule to set_transport_window and stores no window for a non-leg', async () => {
    const res = await chat(app, 'set_transport_window', {
      from: 'Rome', to: 'Florence', earliestDepart: '17:00', latestDepart: null,
      earliestArrive: null, latestArrive: null, explanation: 'x',
    });
    expect(res.body.type).toBe('answer');
    expect(res.body.refresh).toBeUndefined();
  });

  it('applies the same rule to compare_modes (its "Switch" button would ask for the non-leg next)', async () => {
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Florence', explanation: 'x' });
    expect(res.body.type).toBe('answer');
    expect(mockCompareLeg).not.toHaveBeenCalled();
  });

  it('still refreshes a real leg (control)', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'Rome', to: 'Venice', explanation: 'x' });
    expect(res.body.type).toBe('leg_refresh');
    expect(res.body.refresh.fromCity).toBe('Rome');
    expect(res.body.refresh.toCity).toBe('Venice');
    expect(res.body.refresh.date).toBe('2026-12-10');
    expect(res.body.refresh.options.map((o: any) => o.price)).toEqual([110, 120]);
  });

  it('finds the right leg when a city is visited twice (Rome → Florence → Rome)', async () => {
    const t: any = baseTrip();
    t.cities[1] = { ...t.cities[2], name: 'Florence', dates: { arrival: '2026-12-10', departure: '2026-12-12' } };
    t.cities[2] = { ...t.cities[0], name: 'Rome', dates: { arrival: '2026-12-12', departure: '2026-12-14' } };
    const res = await chat(app, 'show_transport_options', { from: 'Florence', to: 'Rome', explanation: 'x' }, t);
    expect(res.body.type).toBe('leg_refresh');
    // Florence's departure, not the first Rome visit's.
    expect(res.body.refresh.date).toBe('2026-12-12');
  });

  it('keeps the existing reply for a city that is not in the trip at all', async () => {
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Paris', explanation: 'x' });
    expect(res.body).toEqual({ type: 'answer', reply: "I couldn't find a Rome → Paris leg in your trip." });
  });
});
