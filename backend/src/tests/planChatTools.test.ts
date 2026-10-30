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
import { normalizeTimeOfDay, searchLegOptions } from '../services/legOptions';
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
    // Both fresh fares are listed. (Whether the leg's current $110 also
    // leads the list is D-03's rule, tested below.)
    expect(res.body.refresh.options.map((o: any) => o.price)).toEqual(expect.arrayContaining([110, 120]));
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

describe('B10 — time windows', () => {
  const app = createApp();
  const windowTool = (bounds: Record<string, any>) => ({
    from: 'Rome', to: 'Venice', earliestDepart: null, latestDepart: null,
    earliestArrive: null, latestArrive: null, explanation: 'x', ...bounds,
  });

  it('reads "5pm" as 17:00 instead of silently dropping it', async () => {
    // Both Rome → Venice options (07:15, 16:00) leave before 17:00.
    const res = await chat(app, 'set_transport_window', windowTool({ earliestDepart: '5pm' }));
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('departing after 17:00');
    expect(res.body.reply).not.toContain('5pm');
  });

  it('filters and stores the normalised bound ("3pm" keeps only the 16:00)', async () => {
    const res = await chat(app, 'set_transport_window', windowTool({ earliestDepart: '3pm' }));
    expect(res.body.type).toBe('leg_refresh');
    expect(res.body.refresh.options.map((o: any) => o.departTime)).toEqual(['16:00']);
    expect(res.body.refresh.updatedConstraints.transport_windows).toEqual([
      { from: 'Rome', to: 'Venice', earliestDepart: '15:00', latestDepart: null, earliestArrive: null, latestArrive: null },
    ]);
    expect(res.body.reply).toContain('departing after 15:00');
  });

  it.each(['evening', '25:00', '5', '13pm'])('refuses an unreadable bound %p, says so, and searches nothing', async (bad) => {
    const res = await chat(app, 'set_transport_window', windowTool({ earliestDepart: bad }));
    expect(res.body.type).toBe('answer');
    expect(res.body.refresh).toBeUndefined();
    expect(res.body.reply).toContain(`"${bad}"`);
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('treats a blank bound as unset, not as unreadable', async () => {
    const res = await chat(app, 'set_transport_window', windowTool({ earliestDepart: '15:00', latestArrive: '' }));
    expect(res.body.type).toBe('leg_refresh');
    expect(res.body.refresh.updatedConstraints.transport_windows[0].latestArrive).toBeNull();
  });
});

describe('normalizeTimeOfDay', () => {
  it.each([
    ['17:00', '17:00'], ['7:05', '07:05'], ['17:00:00', '17:00'], ['00:00', '00:00'],
    ['5pm', '17:00'], ['5 PM', '17:00'], ['5:30pm', '17:30'], ['5 p.m.', '17:00'],
    ['12am', '00:00'], ['12pm', '12:00'], ['11:59 pm', '23:59'], ['noon', '12:00'], [' 9am ', '09:00'],
  ])('%p → %p', (raw, want) => {
    expect(normalizeTimeOfDay(raw)).toBe(want);
  });

  it.each(['5', '17', 'evening', 'midnight', '24:00', '25:00', '13pm', '0am', '5:60pm', '', null, 17])(
    'rejects %p',
    (raw) => {
      expect(normalizeTimeOfDay(raw)).toBeNull();
    },
  );
});

describe('searchLegOptions with an unreadable bound', () => {
  it('throws instead of ignoring it (a caller that skipped the route\'s check)', async () => {
    await expect(
      searchLegOptions({ from: 'Rome', to: 'Venice', date: '2026-12-10', travelers: 1, window: { earliestDepart: 'evening' } }),
    ).rejects.toThrow(/earliestDepart "evening"/);
  });

  it('still filters on a 12-hour bound when called directly', async () => {
    const r = await searchLegOptions({ from: 'Rome', to: 'Venice', date: '2026-12-10', travelers: 1, window: { earliestDepart: '3pm' } });
    expect(r.options.map((o) => o.departTime)).toEqual(['16:00']);
  });
});

describe('B10 — pin_city_dates', () => {
  const app = createApp();
  const pin = (city: string, arrival: any, departure: any) => ({ city, arrival, departure, explanation: 'Pinned it.' });

  it('refuses a pin in the past (it used to move the whole trip to Dec 2024 – Jan 2025)', async () => {
    const res = await chat(app, 'pin_city_dates', pin('Venice', '2025-01-01', '2025-01-03'));
    expect(res.body.type).toBe('answer');
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.reply).toContain('already passed');
  });

  it('allows UTC-yesterday: evening in New York is still that day for the user', async () => {
    // Frozen now is 2026-10-30 15:00Z; 2026-10-29 is "today" nowhere, but a
    // pin made at 20:00 New York time on the 29th reaches us as 00:xx UTC on
    // the 30th — so one day of slack is the rule, tested at its boundary.
    const res = await chat(app, 'pin_city_dates', pin('Rome', '2026-10-29', '2026-10-31'));
    expect(res.body.type).toBe('proposal');
    const res2 = await chat(app, 'pin_city_dates', pin('Rome', '2026-10-28', '2026-10-31'));
    expect(res2.body.type).toBe('answer');
  });

  it('refuses an inverted or zero-night pin', async () => {
    const inverted = await chat(app, 'pin_city_dates', pin('Florence', '2026-12-20', '2026-12-18'));
    expect(inverted.body.type).toBe('answer');
    expect(inverted.body.reply).toContain('after the arrival');
    const zero = await chat(app, 'pin_city_dates', pin('Florence', '2026-12-20', '2026-12-20'));
    expect(zero.body.type).toBe('answer');
  });

  it.each([
    ['Dec 9', 'Dec 12'],
    ['2026-02-30', '2026-03-02'],
    ['2026-12-9', '2026-12-12'],
    [null, '2026-12-12'],
  ])('refuses a non-ISO date %p → %p instead of storing it', async (a, d) => {
    const res = await chat(app, 'pin_city_dates', pin('Rome', a, d));
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('YYYY-MM-DD');
  });

  it('refuses a pin that would push an earlier city into the past', async () => {
    // Florence from Oct 31 leaves Venice Oct 29–31 and Rome Oct 27–29.
    const res = await chat(app, 'pin_city_dates', pin('Florence', '2026-10-31', '2026-11-02'));
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('Rome');
    expect(res.body.reply).toContain('2026-10-27');
  });

  it('refuses a pin whose stays would overlap an existing pin (Venice squeezed between Rome and Florence)', async () => {
    const res = await chat(app, 'pin_city_dates', pin('Florence', '2026-12-13', '2026-12-15'), romePinnedTrip());
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('overlap');
    expect(res.body.reply).toContain('Rome');
    expect(res.body.reply).toContain('Venice');
  });

  it('refuses a pin that overlaps another pin directly', async () => {
    const res = await chat(app, 'pin_city_dates', pin('Venice', '2026-12-11', '2026-12-13'), romePinnedTrip());
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('overlap');
  });

  it('accepts a second pin that leaves exactly enough room (control)', async () => {
    const res = await chat(app, 'pin_city_dates', pin('Florence', '2026-12-14', '2026-12-16'), romePinnedTrip());
    expect(res.body.type).toBe('proposal');
    expect(res.body.reply).toBe('Pinned it.');
  });

  it('accepts a valid pin and shifts the other cities around it (control)', async () => {
    const res = await chat(app, 'pin_city_dates', pin('Venice', '2026-12-11', '2026-12-13'));
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.proposedTrip.cities.map((c: any) => [c.dates.arrival, c.dates.departure])).toEqual([
      ['2026-12-09', '2026-12-11'],
      ['2026-12-11', '2026-12-13'],
      ['2026-12-13', '2026-12-15'],
    ]);
  });
});

describe('B10 — set_min_days', () => {
  const app = createApp();
  const minDays = (city: string, minNights: any, explanation = 'x') => ({ city, minNights, explanation });

  it.each([400, 61, 0, -2, 2.5, 'three', null])('refuses minNights %p and never claims it was applied', async (n) => {
    const res = await chat(app, 'set_min_days', minDays('Rome', n, 'Giving you three nights in Rome.'));
    expect(res.body.type).toBe('answer');
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.reply).not.toContain('Giving you');
    expect(res.body.reply).toContain('1 to 60');
  });

  it('accepts 60, the upper bound', async () => {
    const res = await chat(app, 'set_min_days', minDays('Rome', 60));
    expect(res.body.type).toBe('proposal');
  });

  it('accepts a whole number sent as a string ("3")', async () => {
    const res = await chat(app, 'set_min_days', minDays('Rome', '3'));
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.proposedConstraints.min_days).toEqual([{ city: 'Rome', minNights: 3 }]);
  });

  it('says so when the city is pinned too short, instead of "Giving you six nights"', async () => {
    const res = await chat(app, 'set_min_days', minDays('Rome', 6, 'Giving you six nights in Rome.'), romePinnedTrip());
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('pinned');
    expect(res.body.reply).toContain('2026-12-08');
  });

  it('refuses a minimum that would run into the next pinned city', async () => {
    const t = romePinnedTrip();
    t.constraints.pinned_cities.push({ city: 'Florence', arrival: '2026-12-14', departure: '2026-12-16' });
    const res = await chat(app, 'set_min_days', minDays('Venice', 4, 'Giving you four nights in Venice.'), t);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('overlap');
  });

  it('extends the stay and shifts the rest (control)', async () => {
    const res = await chat(app, 'set_min_days', minDays('Rome', 3, 'Giving you three nights in Rome.'));
    expect(res.body.type).toBe('proposal');
    expect(res.body.reply).toBe('Giving you three nights in Rome.');
    expect(res.body.proposal.proposedTrip.cities.map((c: any) => c.dates.departure)).toEqual([
      '2026-12-11', '2026-12-13', '2026-12-15',
    ]);
  });
});

describe('D-03 — a transport refresh never swaps in a pricier option', () => {
  const app = createApp();
  /** baseTrip with Rome → Venice currently at `price`, optionally overriding its fields. */
  const tripWithRomeVenice = (price: number, extra: Record<string, any> = {}) => {
    const t: any = baseTrip();
    t.cities[0].transportOut = { ...t.cities[0].transportOut, price, ...extra };
    t.cities[1].transportIn = { ...t.cities[1].transportIn, price, ...extra };
    return t;
  };

  it('keeps the current option when nothing fresh is cheaper, and says so', async () => {
    // Fresh Rome → Venice: $110 (16:00) and $120 (07:15); current is $105.
    // Before: options[0] was the $110, which the frontend made the leg's
    // selection — the "cheaper" request raised the trip total by $5.
    const res = await chat(app, 'show_transport_options', { from: 'Rome', to: 'Venice', explanation: 'x' }, tripWithRomeVenice(105));
    expect(res.body.type).toBe('leg_refresh');
    const [first, ...rest] = res.body.refresh.options;
    expect(first).toMatchObject({ mode: 'flight', operator: 'X', price: 105, priceDelta: 0, duration: '1h' });
    expect(rest.map((o: any) => o.price)).toEqual([110, 120]);
    expect(res.body.reply).toContain('nothing cheaper than your current $105');
    expect(res.body.reply).toContain('kept it');
    expect(res.body.reply).not.toMatch(/cheapest is \+/);
  });

  it('keeps the current option on a tie too (no churn for the same price)', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'Rome', to: 'Venice', explanation: 'x' }, tripWithRomeVenice(110));
    expect(res.body.refresh.options[0]).toMatchObject({ operator: 'X', price: 110 });
  });

  it('drops the fresh copy of the current option instead of listing it twice', async () => {
    const res = await chat(
      app,
      'show_transport_options',
      { from: 'Rome', to: 'Venice', explanation: 'x' },
      tripWithRomeVenice(110, { operator: 'Mock Air', departTime: '16:00' }),
    );
    expect(res.body.refresh.options.map((o: any) => `${o.departTime} $${o.price}`)).toEqual(['16:00 $110', '07:15 $120']);
  });

  it('still switches to a fresh option that is cheaper (control)', async () => {
    const res = await chat(app, 'show_transport_options', { from: 'Rome', to: 'Venice', explanation: 'x' }, tripWithRomeVenice(130));
    expect(res.body.refresh.options[0]).toMatchObject({ departTime: '16:00', price: 110, priceDelta: -20 });
    expect(res.body.reply).toContain('cheapest saves $20');
  });

  it('does not apply to set_transport_window, which must move off a current option outside the window', async () => {
    const res = await chat(
      app,
      'set_transport_window',
      { from: 'Rome', to: 'Venice', earliestDepart: '15:00', latestDepart: null, earliestArrive: null, latestArrive: null, explanation: 'x' },
      tripWithRomeVenice(105),
    );
    expect(res.body.refresh.options[0]).toMatchObject({ departTime: '16:00', price: 110 });
  });
});

describe('D-07 — compare_modes reports what was found, not what the model guessed', () => {
  const app = createApp();
  const flight = { id: 'f', price: 95, currency: 'USD', departure: '', arrival: '', durationMinutes: 240, stops: 0, carrier: 'Mock Air', carrierCode: 'MK', bookingUrl: 'https://example.test', raw: {} };
  const train = { id: 't', price: 40, currency: 'USD', departure: '', arrival: '', durationMinutes: 95, operator: 'Trenitalia', bookingUrl: null };
  const guess = "Here's flight vs train for Rome → Venice — flights save about 4 hours.";

  it('says plainly that no train was found, instead of the model\'s invented duration gap', async () => {
    mockCompareLeg.mockResolvedValue({ flightOption: flight, trainOption: null, cheapest: 'flight', fastest: 'flight', recommendation: 'flight', priceDifference: 0, timeDifference: 0 });
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Venice', explanation: guess });
    expect(res.body.type).toBe('mode_comparison');
    expect(res.body.comparison.train).toBeNull();
    expect(res.body.reply).toBe('I found no train for Rome → Venice on 2026-12-10 — only flights, from $95 (4h).');
  });

  it('says plainly that no flight was found', async () => {
    mockCompareLeg.mockResolvedValue({ flightOption: null, trainOption: train, cheapest: 'train', fastest: 'train', recommendation: 'train', priceDifference: 0, timeDifference: 0 });
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Venice', explanation: guess });
    expect(res.body.reply).toBe('I found no flight for Rome → Venice on 2026-12-10 — only trains, from $40 (1h 35m).');
  });

  it('states both found options with the card\'s own numbers', async () => {
    mockCompareLeg.mockResolvedValue({ flightOption: flight, trainOption: train, cheapest: 'train', fastest: 'train', recommendation: 'train', priceDifference: 55, timeDifference: 145 });
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Venice', explanation: guess });
    expect(res.body.reply).toBe('Rome → Venice on 2026-12-10: flight from $95 (4h), train from $40 (1h 35m). The train is both cheaper and faster.');
    expect(res.body.comparison.flight).toMatchObject({ price: 95, duration: '4h' });
    expect(res.body.comparison.train).toMatchObject({ price: 40, duration: '1h 35m' });
  });

  it('states an under-an-hour duration as minutes, not "0h 53m"', async () => {
    mockCompareLeg.mockResolvedValue({ flightOption: { ...flight, durationMinutes: 53 }, trainOption: null, cheapest: 'flight', fastest: 'flight', recommendation: 'flight', priceDifference: 0, timeDifference: 0 });
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Venice', explanation: guess });
    expect(res.body.reply).toBe('I found no train for Rome → Venice on 2026-12-10 — only flights, from $95 (53m).');
    expect(res.body.comparison.flight).toMatchObject({ duration: '53m' });
  });

  it('does not invent a price for a train whose price is unknown', async () => {
    mockCompareLeg.mockResolvedValue({ flightOption: flight, trainOption: { ...train, price: null }, cheapest: 'flight', fastest: 'train', recommendation: 'flight', priceDifference: 0, timeDifference: 145 });
    const res = await chat(app, 'compare_modes', { from: 'Rome', to: 'Venice', explanation: guess });
    expect(res.body.reply).toBe('Rome → Venice on 2026-12-10: flight from $95 (4h), train at an unknown price (1h 35m). The train is faster.');
  });
});

describe('D-07 — chat suggestions only offer what the chat can do', () => {
  const app = createApp();
  const suggest = async (model: string[], trip: any = baseTrip()) => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(model) }] });
    return request(app).post('/api/plan/chat-suggestions').send({ currentTrip: trip });
  };

  it('drops train suggestions when no leg has a train, and activity/booking suggestions always', async () => {
    const res = await suggest(['Why Rome before Venice?', 'Can we take train Rome→Venice?', 'Add Thames river activity in London?', 'No flights before 9am to Florence']);
    expect(res.body.suggestions).toHaveLength(4);
    expect(res.body.suggestions.slice(0, 2)).toEqual(['Why Rome before Venice?', 'No flights before 9am to Florence']);
    expect(res.body.suggestions.join(' ')).not.toMatch(/train|activity/i);
  });

  it('keeps a train suggestion when the trip shows a train on some leg (control)', async () => {
    const t: any = baseTrip();
    t.cities[0].transportOut.alternatives = [{ ...t.cities[0].transportOut, mode: 'train', operator: 'Trenitalia' }];
    const res = await suggest(['Why Rome before Venice?', 'Can we take train Rome→Venice?', 'Give me 3 nights in Venice', 'No flights before 9am to Florence'], t);
    expect(res.body.suggestions).toEqual(['Why Rome before Venice?', 'Can we take train Rome→Venice?', 'Give me 3 nights in Venice', 'No flights before 9am to Florence']);
  });

  it('drops a suggestion about a leg that has no option at all (Zurich → Interlaken share ZRH; rail is dark)', async () => {
    const t: any = baseTrip();
    t.cities[1].transportOut = { ...t.cities[1].transportOut, price: 0, unavailable: true };
    const res = await suggest(
      ['Why Rome before Venice?', 'Cheaper Venice → Florence flight?', 'Flights Venice to Florence after 9am', 'Give me 3 nights in Venice'],
      t,
    );
    expect(res.body.suggestions).toHaveLength(4);
    expect(res.body.suggestions.slice(0, 2)).toEqual(['Why Rome before Venice?', 'Give me 3 nights in Venice']);
    expect(res.body.suggestions.join(' ')).not.toMatch(/Venice\s*(→|->|to)\s*Florence/i);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain('"optionFound": false');
  });

  it('keeps suggestions about legs that have an option (control)', async () => {
    const res = await suggest(['Why Rome before Venice?', 'Cheaper Venice → Florence flight?', 'Flights Rome to Venice after 9am', 'Give me 3 nights in Venice']);
    expect(res.body.suggestions).toEqual(['Why Rome before Venice?', 'Cheaper Venice → Florence flight?', 'Flights Rome to Venice after 9am', 'Give me 3 nights in Venice']);
  });

  it('tells the model which legs have trains and what the chat can do', async () => {
    await suggest(['a', 'b', 'c', 'd']);
    const req = mockCreate.mock.calls[0][0];
    expect(req.system).toMatch(/can NOT/i);
    expect(req.messages[0].content).toContain('"trainFound": false');
  });
});

/**
 * The model can only resolve "Dec 10" to the right year if it knows today.
 * The /chat prompt used to omit it, and wrong-year pins were the likely
 * result (now refused as "already passed"). A scripted model can't show the
 * resolution itself, so these pin the date into every planner prompt and
 * check it is computed per request, not frozen at first use.
 */
describe("today's date in the planner prompts", () => {
  const app = createApp();
  const systemOf = (call: number) => mockCreate.mock.calls[call][0].system as string;
  afterEach(() => jest.setSystemTime(new Date(FROZEN_NOW)));

  it('/chat tells the model today (UTC) and that a yearless date means its next occurrence', async () => {
    await chat(app, 'answer_only', { answer: 'ok' });
    expect(systemOf(0)).toContain('Today is 2026-10-30 (UTC).');
    expect(systemOf(0)).toContain('next occurrence after today');
  });

  it('/chat recomputes the date on every request (no cross-day caching)', async () => {
    await chat(app, 'answer_only', { answer: 'ok' });
    jest.setSystemTime(new Date('2026-10-31T01:00:00Z'));
    await chat(app, 'answer_only', { answer: 'ok' });
    expect(systemOf(0)).toContain('Today is 2026-10-30 (UTC).');
    expect(systemOf(1)).toContain('Today is 2026-10-31 (UTC).');
  });

  it('/chat-suggestions tells the model today (UTC)', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '["a","b","c","d"]' }] });
    await request(app).post('/api/plan/chat-suggestions').send({ currentTrip: baseTrip() });
    expect(systemOf(0)).toContain('Today is 2026-10-30 (UTC).');
  });

  it('/converse tells the model today (UTC) and that trip dates are in the future', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', name: 'respond_to_traveler', input: { reply: 'ok', updates: {}, action: 'ask' } }],
    });
    const res = await request(app).post('/api/plan/converse').send({ message: 'Rome Dec 10' });
    expect(res.status).toBe(200);
    expect(systemOf(0)).toContain("Today's date: 2026-10-30 (UTC).");
    expect(systemOf(0)).toContain('next occurrence after today');
  });
});
