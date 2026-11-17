/**
 * BlueMurr AI dinner plans: add_dinner / change_dinner / remove_dinner.
 *
 * Production: on a Paris + London trip, "Can you add a dinner reservation for
 * one night in paris" was answered "I can't make reservations" with a list of
 * OpenTable / TheFork / Resy. Now the chat proposes a dinner on a night of the
 * Paris stay, from the city's dining picks, for the trip's travellers, marked
 * not booked with a Reserve link — applied only on Accept.
 *
 * Scaffolding as in cityRouteEdits.test.ts: the model is scripted with a
 * mocked messages.create; the route, the tools and the pricing are real.
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
  searchHomeLegOptions: async (p: any) => {
    const l = await mockBuildHomeLeg(p);
    if (!l) return [];
    const { alternatives, ...main } = l;
    return [main, ...(alternatives ?? [])];
  },
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { chatSystemPrompt, CHAT_TOOLS } from '../services/tripChat';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/plan', planRouter);
app.use(errorHandler);

const homeLeg = (dest: string, date: string, price: number, extra: any = {}) => ({
  originAirport: 'JFK', destAirport: dest.slice(0, 3).toUpperCase(), price, currency: 'USD', durationMinutes: 450,
  operator: 'Air', carrierCode: 'AA', departTime: '18:00', arriveTime: '07:30', departDate: date, stops: 0, bookingUrl: null, ...extra,
});

/** Paris 3 nights (Dec 14–17) → London 2 nights (Dec 17–19), 2 travellers, from New York. */
const parisLondon = (): any => ({
  title: 'Paris → London',
  travelers: 2,
  returnToHome: true,
  origin: {
    city: 'New York',
    airports: ['JFK'],
    outboundLeg: homeLeg('Paris', '2026-12-13', 900, { arriveDate: '2026-12-14' }),
    returnLeg: homeLeg('London', '2026-12-19', 800, { departTime: '12:00', arriveTime: '15:00' }),
  },
  cities: [
    {
      name: 'Paris', country: 'France', dates: { arrival: '2026-12-14', departure: '2026-12-17' },
      transportOut: { mode: 'train', operator: 'Eurostar', duration: '2h 20m', price: 180, from: 'Paris', to: 'London', departTime: '10:00', arriveTime: '11:20' },
      restaurants: [
        { name: 'Le Comptoir du Relais', cuisine: 'French bistro', priceRange: '$$', lat: 48.852, lng: 2.339 },
        { name: 'Septime', cuisine: 'Modern French', priceRange: '$$$' },
        { name: 'Pink Mamma', cuisine: 'Italian', priceRange: '$$' },
      ],
      schedule: {
        '2026-12-15': [
          { id: 'p1', title: 'Louvre', startTime: '10:00', endTime: '13:00', category: 'activity', plannedDurationMin: 180 },
          { id: 'p2', title: 'Septime (Modern French)', startTime: '19:00', endTime: '21:00', category: 'restaurant', notes: '$$$ · seasonal', plannedDurationMin: 120 },
        ],
      },
    },
    {
      name: 'London', country: 'United Kingdom', dates: { arrival: '2026-12-17', departure: '2026-12-19' },
      transportIn: { mode: 'train', operator: 'Eurostar', duration: '2h 20m', price: 180, from: 'Paris', to: 'London', departTime: '10:00', arriveTime: '11:20' },
      restaurants: [{ name: 'Dishoom', cuisine: 'Indian', priceRange: '$$' }],
    },
  ],
});

async function chat(name: string, input: any, trip: any = parisLondon()) {
  mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name, input }] });
  return request(app).post('/api/plan/chat').send({ message: 'x', currentTrip: trip });
}

/** The trip with a proposal's dinner applied, as the frontend does on Accept. */
function withDinner(trip: any, p: any): any {
  const t = JSON.parse(JSON.stringify(trip));
  const i = t.cities.findIndex((c: any) => c.name === p.city);
  const sched = (t.cities[i].schedule ??= {});
  if (p.before) sched[p.before.date] = (sched[p.before.date] ?? []).filter((e: any) => e.id !== p.before.event.id);
  if (p.after) sched[p.after.date] = [...(sched[p.after.date] ?? []), p.after.event];
  return t;
}

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-17T12:00:00Z'),
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
  mockSearchLegOptions.mockImplementation(async () => ({
    options: [{ mode: 'train', operator: 'Eurostar', flightNumber: null, price: 180, currency: 'USD', departTime: '10:00', arriveTime: '11:20', duration: '2h 20m', durationMinutes: 140, stops: 0, priceDelta: 0, bookingUrl: null }],
    hasMatches: true,
    windowFilteredAll: false,
  }));
  mockBuildHomeLeg.mockImplementation(async ({ destinationCity, date }: any) => homeLeg(destinationCity, date, 820));
});

describe('"add a dinner reservation for one night in Paris"', () => {
  it('proposes a dinner on a night of the Paris stay, from its picks, for the travellers, at 19:30 — not booked, with a Reserve link', async () => {
    const res = await chat('add_dinner', { city: 'Paris', date: null, time: null, restaurant: null, cuisine: null, priceRange: null, partySize: null });
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p).toMatchObject({ kind: 'dinner', action: 'add', city: 'Paris', before: null });
    // A full day there first: the second night, not the morning-arrival one.
    expect(p.after.date).toBe('2026-12-15');
    const e = p.after.event;
    expect(e).toMatchObject({ startTime: '19:30', endTime: '21:30', category: 'restaurant' });
    // The planner had Septime on that evening: the dinner is Septime, so nothing is lost.
    expect(e.dinner).toMatchObject({ restaurant: 'Septime', city: 'Paris', partySize: 2, status: 'not_booked', reserveVia: 'Google Maps' });
    expect(e.dinner.reserveUrl).toBe('https://www.google.com/maps/search/?api=1&query=Septime%2C%20Paris');
    expect(res.body.reply).toBe(
      "Here's dinner for 2 people at Septime (Modern French, $$$) from your Paris dining picks, Tue, Dec 15 at 7:30 PM in Paris — your second night there. It isn't booked — once it's on your trip, use Reserve to book the table yourself (it opens the restaurant on Google Maps). Accept to add it to your schedule.",
    );
    expect(res.body.reply).not.toMatch(/\b(confirmed|booked for you|reserved for you)\b/i);
  });

  it('never picks a restaurant the schedule already has on another day (live: Clown Bar on Friday and again on Saturday)', async () => {
    // The 15th's planned dinner is Septime; the dinner goes on the 16th (the 15th is taken by a dinner plan).
    const trip = parisLondon();
    trip.cities[0].schedule['2026-12-15'][1] = { id: 'p2', title: 'Le Comptoir du Relais (French bistro)', startTime: '18:00', endTime: '20:00', category: 'restaurant', plannedDurationMin: 120 };
    const res = await chat('add_dinner', { city: 'Paris', date: '2026-12-16' }, trip);
    expect(res.body.type).toBe('proposal');
    // Le Comptoir is first in the picks, but it is already Tuesday's dinner.
    expect(res.body.proposal.after.event.dinner.restaurant).toBe('Septime');
  });

  it('when every pick is already on the schedule, it still proposes one rather than refusing', async () => {
    const trip = parisLondon();
    trip.cities[0].schedule['2026-12-14'] = [
      { id: 'a', title: 'Le Comptoir du Relais (French bistro)', startTime: '19:00', endTime: '21:00', category: 'restaurant', plannedDurationMin: 120 },
      { id: 'b', title: 'Pink Mamma (Italian)', startTime: '12:30', endTime: '13:30', category: 'restaurant', plannedDurationMin: 60 },
    ];
    const res = await chat('add_dinner', { city: 'Paris', date: '2026-12-16' }, trip);
    expect(res.body.type).toBe('proposal');
    expect(['Le Comptoir du Relais', 'Septime', 'Pink Mamma']).toContain(res.body.proposal.after.event.dinner.restaurant);
  });

  it('a cuisine hint picks the matching restaurant, keeps its coordinates, and says what it replaces that evening', async () => {
    const res = await chat('add_dinner', { city: 'Paris', cuisine: 'bistro' });
    const e = res.body.proposal.after.event;
    expect(e.dinner.restaurant).toBe('Le Comptoir du Relais');
    expect(e).toMatchObject({ lat: 48.852, lng: 2.339, notes: 'French bistro · $$' });
    expect(res.body.proposal.replacesPlanned).toBe('Septime');
    expect(res.body.reply).toContain('It takes the place of Septime, which was planned for that evening.');
  });

  it('a hint none of the picks matches lists them instead of inventing one', async () => {
    const res = await chat('add_dinner', { city: 'Paris', cuisine: 'Japanese' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('None of your Paris dining picks is Japanese');
    expect(res.body.reply).toContain('Le Comptoir du Relais (French bistro, $$); Septime (Modern French, $$$); Pink Mamma (Italian, $$)');
  });

  it('a named restaurant, night, time and party size are used as given', async () => {
    const res = await chat('add_dinner', { city: 'paris', date: '2026-12-16', time: '20:00', restaurant: 'Chez Janou', partySize: 4 });
    const p = res.body.proposal;
    expect(p.after.date).toBe('2026-12-16');
    expect(p.after.event).toMatchObject({ title: 'Chez Janou', startTime: '20:00', endTime: '22:00', dinner: { restaurant: 'Chez Janou', partySize: 4 } });
  });

  it('a night outside the stay is not proposed; the stay\'s nights are listed', async () => {
    const res = await chat('add_dinner', { city: 'Paris', date: '2026-12-17' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toBe("Thu, Dec 17 isn't one of your nights in Paris — those are Mon, Dec 14, Tue, Dec 15, Wed, Dec 16. Which one?");
  });

  it('a city that is not on the trip is not proposed', async () => {
    const res = await chat('add_dinner', { city: 'Rome' });
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain("Rome isn't on this trip — its cities are Paris, London.");
  });

  it('the night you land too late for is skipped (London: only night is fine at 11:20; a 23:30 landing is not)', async () => {
    const t = parisLondon();
    t.cities = [t.cities[0]];
    t.cities[0].dates = { arrival: '2026-12-14', departure: '2026-12-15' };
    t.origin.outboundLeg.arriveTime = '19:00';
    const res = await chat('add_dinner', { city: 'Paris' }, t);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('Want a later time?');
  });
});

describe('changing and cancelling it', () => {
  async function added() {
    const res = await chat('add_dinner', { city: 'Paris' });
    return withDinner(parisLondon(), res.body.proposal);
  }

  it('"make it 8pm": same night, same restaurant, new time', async () => {
    const trip = await added();
    const res = await chat('change_dinner', { time: '20:00' }, trip);
    expect(res.body.type).toBe('proposal');
    const p = res.body.proposal;
    expect(p.action).toBe('change');
    expect(p.before.event.startTime).toBe('19:30');
    expect(p.after.date).toBe('2026-12-15');
    expect(p.after.event).toMatchObject({ id: p.before.event.id, startTime: '20:00', endTime: '22:00', dinner: { restaurant: 'Septime' } });
    expect(res.body.reply).toContain('7:30 PM → 8:00 PM');
  });

  it('"move it to the next night"', async () => {
    const trip = await added();
    const res = await chat('change_dinner', { shiftNights: 1 }, trip);
    expect(res.body.proposal.after.date).toBe('2026-12-16');
    expect(res.body.reply).toContain('moves from Tue, Dec 15 to Wed, Dec 16');
  });

  it('moving it past the stay is refused', async () => {
    const trip = await added();
    const res = await chat('change_dinner', { shiftNights: 2 }, trip);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain("Thu, Dec 17 isn't one of your nights in Paris");
  });

  it('"cancel the dinner": a remove proposal that never claims a booking was cancelled', async () => {
    const trip = await added();
    const res = await chat('remove_dinner', {}, trip);
    expect(res.body.proposal).toMatchObject({ kind: 'dinner', action: 'remove', after: null, city: 'Paris' });
    expect(res.body.reply).toContain('It was never booked through BlueMurr');
  });

  it('with no dinner on the trip, change / cancel say so', async () => {
    const res = await chat('remove_dinner', {});
    expect(res.body).toEqual({ type: 'answer', reply: "There's no dinner on your trip yet — want me to add one?" });
  });
});

describe('edits elsewhere say what happens to the dinner', () => {
  it('dropping Paris says the dinner goes with it', async () => {
    const first = await chat('add_dinner', { city: 'Paris' });
    const trip = withDinner(parisLondon(), first.body.proposal);
    const res = await chat('remove_city', { city: 'Paris', explanation: 'x' }, trip);
    expect(res.body.type).toBe('proposal');
    expect(res.body.reply).toContain('Your dinner at Septime (Tue, Dec 15) is removed with Paris.');
  });

  it('a pin that takes the dinner\'s night away says where it moves', async () => {
    const first = await chat('add_dinner', { city: 'Paris', date: '2026-12-16' });
    const trip = withDinner(parisLondon(), first.body.proposal);
    // Paris pinned to Dec 14–16: Dec 16 is no longer a Paris night.
    const res = await chat('pin_city_dates', { city: 'Paris', arrival: '2026-12-14', departure: '2026-12-16', explanation: 'Pinned.' }, trip);
    expect(res.body.type).toBe('proposal');
    expect(res.body.reply).toContain("Your dinner at Le Comptoir du Relais (Wed, Dec 16) moves to Tue, Dec 15, the nearest night you're still in Paris.");
  });
});

describe('the model is told it can do this', () => {
  it('lists the dinner tools and forbids the "I can\'t make reservations" answer', () => {
    const names = CHAT_TOOLS.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['add_dinner', 'change_dinner', 'remove_dinner']));
    const prompt = chatSystemPrompt(parisLondon());
    expect(prompt).toMatch(/never answer that you can't make reservations/);
    expect(prompt).toMatch(/never claim a table is booked/);
    // The trip's nights and dining picks are in its context.
    expect(prompt).toContain('"Le Comptoir du Relais (French bistro, $$)"');
    expect(prompt).toContain('"2026-12-16"');
  });
});

describe('a dinner survives a save and a load', () => {
  it('the saved city row keeps it on cities.schedule (jsonb), and loading rebuilds it unchanged', async () => {
    const { buildTripFromDb } = await import('../utils/tripShape');
    const first = await chat('add_dinner', { city: 'Paris' });
    const trip = withDinner(parisLondon(), first.body.proposal);
    // routes/trips.ts writes `schedule: c.schedule ?? {}` for each city.
    const rows = trip.cities.map((c: any, i: number) => ({ id: `c${i}`, trip_id: 't', position: i, name: c.name, country: c.country, arrival_date: c.dates.arrival, departure_date: c.dates.departure, activities: [], restaurants: c.restaurants, schedule: JSON.parse(JSON.stringify(c.schedule ?? {})) }));
    const loaded = buildTripFromDb({ id: 't', title: 'x', travelers: 2 } as any, rows as any, []);
    expect(loaded.cities[0].schedule['2026-12-15'].find((e: any) => e.dinner)).toEqual(first.body.proposal.after.event);
  });
});

describe('"make it Italian instead": a cuisine is not a restaurant name', () => {
  // Live: change_dinner had no cuisine field, so the model passed "Italian"
  // as the restaurant and the dinner became a restaurant called "Italian".
  it('change_dinner takes a cuisine hint and picks a restaurant of that kind from the city\'s picks', async () => {
    const first = await chat('add_dinner', { city: 'Paris' });
    const trip = withDinner(parisLondon(), first.body.proposal);
    const res = await chat('change_dinner', { cuisine: 'Italian', time: '20:15' }, trip);
    expect(res.body.type).toBe('proposal');
    expect(res.body.proposal.after.event).toMatchObject({ title: 'Pink Mamma', startTime: '20:15', dinner: { restaurant: 'Pink Mamma', cuisine: 'Italian' } });
    expect(res.body.reply).toContain('Septime → Pink Mamma');
    const tool = CHAT_TOOLS.find((t: any) => t.name === 'change_dinner') as any;
    expect(tool.input_schema.properties.cuisine).toBeDefined();
  });

  it('a cuisine none of the other picks has: says so, changes nothing', async () => {
    const first = await chat('add_dinner', { city: 'Paris' });
    const trip = withDinner(parisLondon(), first.body.proposal);
    const res = await chat('change_dinner', { cuisine: 'Thai' }, trip);
    expect(res.body.type).toBe('answer');
    expect(res.body.reply).toContain('None of your other Paris dining picks is Thai');
  });
});
