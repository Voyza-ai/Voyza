/**
 * BlueMurr AI chat: weather on the trip's own days, and packing help.
 *
 * Drives the real POST /api/plan/chat route with the model scripted (first
 * call picks the tool, second call words the answer) and the weather
 * providers faked at the network (weather.ts setWeatherFetch). What these pin
 * down: forecast vs typical is labelled; days past the forecast fall back to
 * typical; a provider failure is said plainly; a model that states a number
 * the server didn't fetch is overruled by the data; the packing list follows
 * the trip's weather, plans, travel and plugs.
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
jest.mock('../services/flights', () => ({ searchFlights: jest.fn(), getIataCode: jest.fn(async (c: string) => c.slice(0, 3).toUpperCase()) }));
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { CHAT_TOOLS } from '../services/tripChat';
import { __resetWeatherCache, setWeatherFetch, tripCityDays, typicalFor } from '../services/weather';
import { packingFacts } from '../services/packing';
import { addDays, todayIso } from '../utils/dates';

const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
app.use(errorHandler);

// ─── Fake providers ──────────────────────────────────────────────────

const TODAY = todayIso();
const YEAR = Number(TODAY.slice(0, 4));

/** MET Norway compact JSON: hourly for `days` days from today, with a set high/low and rain per day. */
function metJson(perDay: (i: number) => { hi: number; lo: number; rainMm: number; sym: string }, days = 9) {
  const timeseries: any[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(TODAY, i);
    const { hi, lo, rainMm, sym } = perDay(i);
    for (let h = 0; h < 24; h++) {
      // Coldest at 05:00, warmest at 15:00 (UTC = local for lon ~0–7).
      const temp = h === 15 ? hi : h === 5 ? lo : (hi + lo) / 2;
      timeseries.push({
        time: `${date}T${String(h).padStart(2, '0')}:00:00Z`,
        data: {
          instant: { details: { air_temperature: temp } },
          next_1_hours: { summary: { symbol_code: sym }, details: { precipitation_amount: h === 14 ? rainMm : 0 } },
        },
      });
    }
  }
  return { properties: { timeseries } };
}

/** NASA POWER daily JSON for the last 10 years: highs/lows by month, wet every 3rd day. */
function nasaJson(byMonth: (m: number) => { hi: number; lo: number }) {
  const hi: Record<string, number> = {};
  const lo: Record<string, number> = {};
  const pr: Record<string, number> = {};
  let n = 0;
  for (let d = `${YEAR - 10}-01-01`; d <= `${YEAR - 1}-12-31`; d = addDays(d, 1)) {
    const k = d.replace(/-/g, '');
    const m = Number(d.slice(5, 7));
    hi[k] = byMonth(m).hi;
    lo[k] = byMonth(m).lo;
    pr[k] = n++ % 3 === 0 ? 4 : 0;
  }
  return { properties: { parameter: { T2M_MAX: hi, T2M_MIN: lo, PRECTOTCORR: pr } } };
}

type Fake = { met?: any | 'fail'; nasa?: any | 'fail'; noaa?: 'none' | 'fail' };
const calls: string[] = [];
function fakeWeather(f: Fake) {
  calls.length = 0;
  const json = (body: any, headers: Record<string, string> = {}) =>
    ({ ok: true, status: 200, headers: { get: (h: string) => headers[h.toLowerCase()] ?? null }, json: async () => body }) as any;
  setWeatherFetch((async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.met.no')) {
      if (!f.met || f.met === 'fail') throw new Error('MET down');
      return json(f.met, { expires: new Date(Date.now() + 3600_000).toUTCString() });
    }
    if (u.includes('ncei.noaa.gov')) {
      if (f.noaa === 'fail') throw new Error('NOAA down');
      return json(u.includes('/search/') ? { results: [] } : []);
    }
    if (u.includes('power.larc.nasa.gov')) {
      if (!f.nasa || f.nasa === 'fail') throw new Error('NASA down');
      return json(f.nasa);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as any);
}

// Paris: warm-ish forecast; January-like climate (hi 7, lo 2) for typical.
const PARIS_CLIMATE = (m: number) => (m <= 2 || m === 12 ? { hi: 7, lo: 2 } : m >= 6 && m <= 8 ? { hi: 31, lo: 20 } : { hi: 15, lo: 8 });

// ─── Trips ───────────────────────────────────────────────────────────

function trip(startOffset: number, opts: { dinner?: boolean; activities?: string[] } = {}) {
  const a = addDays(TODAY, startOffset);
  const b = addDays(a, 3);
  const c = addDays(b, 3);
  const flight = (from: string, to: string, date: string) => ({ mode: 'flight', operator: 'Air France', duration: '1h 15m', price: 200, from, to, departDate: date });
  return {
    title: 'Paris & London',
    travelers: 2,
    totalCost: 3000,
    origin: {
      city: 'New York',
      airports: ['JFK'],
      outboundLeg: { originAirport: 'JFK', destAirport: 'CDG', price: 900, currency: 'USD', durationMinutes: 450, operator: 'Delta', carrierCode: 'DL', departTime: '18:00', arriveTime: '07:30', departDate: addDays(a, -1), stops: 0, bookingUrl: null },
      returnLeg: { originAirport: 'LHR', destAirport: 'JFK', price: 900, currency: 'USD', durationMinutes: 480, operator: 'BA', carrierCode: 'BA', departTime: '11:00', arriveTime: '14:00', departDate: c, stops: 0, bookingUrl: null },
    },
    returnToHome: true,
    cities: [
      {
        name: 'Paris',
        country: 'France',
        dates: { arrival: a, departure: b },
        transportIn: flight('New York', 'Paris', a),
        transportOut: flight('Paris', 'London', b),
        hotel: { name: 'H', pricePerNight: 200 },
        hotels: [],
        selectedHotelIndex: 0,
        activities: opts.activities ?? ['Louvre Museum', 'Notre-Dame Cathedral'],
        restaurants: [{ name: 'Le Cinq', cuisine: 'French', priceRange: '$$$$' }],
        schedule: opts.dinner
          ? { [addDays(a, 1)]: [{ id: 'd1', title: 'Dinner at Le Cinq', startTime: '20:00', endTime: '22:00', category: 'restaurant', dinner: { restaurant: 'Le Cinq', city: 'Paris', partySize: 2, priceRange: '$$$$', status: 'not_booked', reserveUrl: 'x', reserveVia: 'x' } }] }
          : {},
      },
      {
        name: 'London',
        country: 'United Kingdom',
        dates: { arrival: b, departure: c },
        transportIn: flight('Paris', 'London', b),
        transportOut: flight('London', 'New York', c),
        hotel: { name: 'H2', pricePerNight: 250 },
        hotels: [],
        selectedHotelIndex: 0,
        activities: ['British Museum'],
        restaurants: [],
        schedule: {},
      },
    ],
  };
}

/** Script the model: pick `tool` with `input`, then word the answer as `writer`. */
function scriptModel(tool: string, input: any, writer: string | ((req: any) => string)) {
  mockCreate.mockImplementation(async (req: any) => {
    if (req.tools) return { content: [{ type: 'tool_use', name: tool, input }] };
    return { content: [{ type: 'text', text: typeof writer === 'function' ? writer(req) : writer }] };
  });
}

const ask = (currentTrip: any, message: string) => request(app).post('/api/plan/chat').send({ message, currentTrip, history: [] });

beforeEach(() => {
  __resetWeatherCache();
  mockCreate.mockReset();
});
afterAll(() => setWeatherFetch(null));

// ─── Tests ───────────────────────────────────────────────────────────

describe('get_weather', () => {
  it('is a chat tool, and answer_only no longer offers weather as an example', () => {
    const names = CHAT_TOOLS.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_weather', 'packing_list']));
    const answerOnly: any = CHAT_TOOLS.find((t: any) => t.name === 'answer_only');
    expect(answerOnly.description).not.toMatch(/weather like in Rome/);
  });

  it('answers a trip a few days out from the FORECAST for the days in Paris, labelled', async () => {
    fakeWeather({ met: metJson((i) => ({ hi: 12 + i, lo: 6, rainMm: i === 2 ? 3.2 : 0, sym: i === 2 ? 'rain' : 'cloudy' })), nasa: nasaJson(PARIS_CLIMATE) });
    const t = trip(1);
    let writerSaw = '';
    scriptModel('get_weather', { city: 'Paris' }, (req) => {
      writerSaw = req.messages[0].content;
      return 'Forecast for Paris: highs 13–15°C, lows around 6°C; rain (3.2 mm) on the second day.';
    });
    const res = await ask(t, "What's the weather in Paris on our days?");
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/^Forecast for Paris/);
    // The writer got exactly Paris's days (arrival .. day before departure), as forecast.
    const days = tripCityDays(t)[0].dates;
    expect(days).toHaveLength(3);
    for (const d of days) expect(writerSaw).toContain(d);
    expect(writerSaw).toContain('MET Norway forecast');
    expect(writerSaw).not.toContain('Typical for');
    expect(calls.some((u) => u.includes('api.met.no'))).toBe(true);
    // MET's terms: an identifying User-Agent.
  });

  it('overrules a model reply that states a temperature the server did not fetch', async () => {
    fakeWeather({ met: metJson(() => ({ hi: 12, lo: 6, rainMm: 0, sym: 'cloudy' })), nasa: nasaJson(PARIS_CLIMATE) });
    scriptModel('get_weather', { city: 'Paris' }, 'Forecast for Paris: a lovely 24°C all week!');
    const res = await ask(trip(1), "What's the weather in Paris on our days?");
    expect(res.body.reply).not.toMatch(/24°C/);
    expect(res.body.reply).toMatch(/forecast \(MET Norway\)/);
    expect(res.body.reply).toMatch(/high 12°C \(54°F\), low 6°C \(43°F\)/); // New York home → °F too
  });

  it('uses TYPICAL averages for a trip months away — no forecast call, labelled as not a forecast', async () => {
    fakeWeather({ met: 'fail', nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    // Start on the next Jan 15 that's > 10 days away.
    const jan15 = `${TODAY.slice(5) < '01-05' ? YEAR : YEAR + 1}-01-15`;
    const offset = Math.round((Date.parse(jan15) - Date.parse(TODAY)) / 86_400_000);
    scriptModel('get_weather', { city: 'Paris' }, 'It will be 30°C and sunny.'); // invented — must be overruled
    const res = await ask(trip(offset), "What's the weather in Paris on our days?");
    expect(calls.some((u) => u.includes('api.met.no'))).toBe(false);
    expect(res.body.reply).toMatch(/typical for those dates \(averages of \d{4}–\d{4}, NASA POWER; not a forecast\)/);
    expect(res.body.reply).toMatch(/highs about 7°C \(45°F\), lows about 2°C \(36°F\)/);
    expect(res.body.reply).toMatch(/rained on about 33% of these days/);
    expect(res.body.reply).not.toMatch(/30°C/);
  });

  it('rejects a reply that gives typical figures without saying they are typical', async () => {
    fakeWeather({ nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    scriptModel('get_weather', { city: 'Paris' }, 'Paris: highs 7°C, lows 2°C.');
    const res = await ask(trip(60), 'How cold will Paris be?');
    expect(res.body.reply).toMatch(/not a forecast/);
  });

  it('accepts a correct, labelled typical reply as written', async () => {
    fakeWeather({ nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    scriptModel('get_weather', { city: 'Paris' }, 'Typical for your dates (averages of past years, not a forecast): highs about 7°C, lows about 2°C.');
    const res = await ask(trip(60), 'How cold will Paris be?');
    // Month 60 days out isn't necessarily winter — the fixture climate decides what's correct.
    const m = Number(addDays(TODAY, 60).slice(5, 7));
    if (PARIS_CLIMATE(m).hi === 7) expect(res.body.reply).toMatch(/^Typical for your dates/);
    else expect(res.body.reply).toMatch(/not a forecast\):/);
  });

  it('falls back to typical for trip days past the forecast range', async () => {
    fakeWeather({ met: metJson(() => ({ hi: 12, lo: 6, rainMm: 0, sym: 'cloudy' }), 9), nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    scriptModel('get_weather', { city: null }, 'nonsense 99°C');
    const res = await ask(trip(6), 'Weather for the whole trip?');
    // Paris (days 6–8) is forecast; London (days 9–12) runs past the 9-day forecast.
    expect(res.body.reply).toMatch(/Paris, .* — forecast \(MET Norway\)/);
    expect(res.body.reply).toMatch(/London, .* — typical for those dates/);
  });

  it('says plainly when no weather could be fetched — and gives no numbers', async () => {
    fakeWeather({ met: 'fail', nasa: 'fail', noaa: 'fail' });
    scriptModel('get_weather', { city: 'London' }, 'London will be 10°C.');
    const res = await ask(trip(2), 'Will it rain in London?');
    expect(res.body.reply).toMatch(/couldn't get the weather/);
    expect(res.body.reply).not.toMatch(/\d\s*°/);
    // The writer isn't even asked.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a city that is not on the trip, with no dates, asks for dates', async () => {
    fakeWeather({ met: 'fail', nasa: 'fail' });
    scriptModel('get_weather', { city: 'Madrid' }, 'x');
    const res = await ask(trip(2), "What's the weather in Madrid?");
    expect(res.body.reply).toMatch(/Madrid isn't on this trip/);
  });
});

describe('typical averages', () => {
  it('averages the same calendar days (±3) across past years', () => {
    const h: any = { years: [2016, 2025], source: 'x', hi: {}, lo: {}, pr: {} };
    for (let y = 2016; y <= 2025; y++) {
      for (let d = `${y}-01-10`; d <= `${y}-01-20`; d = addDays(d, 1)) {
        const k = d.replace(/-/g, '');
        h.hi[k] = d.endsWith('15') ? 10 : 6; // one warm day per year
        h.lo[k] = 1;
        h.pr[k] = d.endsWith('15') ? 5 : 0;
      }
    }
    const t = typicalFor(h, '2027-01-15')!;
    expect(t.highC).toBeCloseTo((10 + 6 * 6) / 7, 1);
    expect(t.lowC).toBe(1);
    expect(t.wetDayShare).toBeCloseTo(1 / 7, 2);
    expect(typicalFor(h, '2027-07-15')).toBeNull(); // no data → nothing, never a guess
  });
});

describe('packing_list', () => {
  const winterOffset = () => {
    const jan15 = `${TODAY.slice(5) < '01-05' ? YEAR : YEAR + 1}-01-15`;
    return Math.round((Date.parse(jan15) - Date.parse(TODAY)) / 86_400_000);
  };

  it('a cold, rainy Paris with a $$$$ dinner, flights and a US home: coat, umbrella, smart outfit, liquids, type C/E adapter', async () => {
    fakeWeather({ nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    scriptModel('packing_list', { city: 'Paris' }, 'It will be 18°C so pack shorts.'); // invented → overruled
    const res = await ask(trip(winterOffset(), { dinner: true }), 'What should I pack for Paris?');
    const r = res.body.reply as string;
    expect(r).toMatch(/^What to pack for Paris/);
    expect(r).toMatch(/Warm winter coat.*Paris lows around 2°C \(typical for your dates\)/);
    expect(r).toMatch(/umbrella.*rained on about 33%/);
    expect(r).toMatch(/smart outfit.*dinner at Le Cinq \(\$\$\$\$\)/);
    expect(r).toMatch(/100 ml/);
    expect(r).toMatch(/type C\/E for France/);
    expect(r).toMatch(/France is 230V; New York is 120V/);
    expect(r).toMatch(/scarf or layer to cover shoulders.*Notre-Dame/);
    expect(r).toMatch(/Passport/);
    expect(r).not.toMatch(/shorts|18°C/);
  });

  it('a hot trip gets sun protection, not a winter coat; no dinner plan → no smart outfit', () => {
    const t = trip(10, { activities: ['Beach day at Paris Plages'] });
    const hot = [
      { city: 'Paris', country: 'FR', dates: [], days: [{ date: 'x', kind: 'typical' as const, highC: 33, lowC: 21, wetDayShare: 0.05 }], missing: [] },
    ];
    const f = packingFacts(t, hot as any, 'Paris');
    const items = f.items.map((i) => i.item).join(' | ');
    expect(items).toMatch(/sunscreen/);
    expect(items).toMatch(/Swimsuit/);
    expect(items).not.toMatch(/winter coat|umbrella/);
    expect(items).not.toMatch(/smart outfit/i);
  });

  it('London from New York needs a type G adapter; a train-only trip gets no liquids rule', () => {
    const t: any = trip(10);
    for (const c of t.cities) {
      c.transportIn = { ...c.transportIn, mode: 'train' };
      c.transportOut = { ...c.transportOut, mode: 'train' };
    }
    t.origin = { city: 'London', airports: ['LHR'] };
    t.returnToHome = false;
    const f = packingFacts(t, [], null);
    const items = f.items.map((i) => `${i.item} — ${i.why}`).join(' | ');
    expect(items).toMatch(/type C\/E for France/);
    expect(f.items.map((i) => i.item).join(' | ')).not.toMatch(/type G/); // home is London: UK plugs already
    expect(items).not.toMatch(/100 ml/);
    expect(items).toMatch(/trains have no liquid limits/);
  });

  it('accepts a model-worded list whose numbers all come from the data', async () => {
    fakeWeather({ nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    const worded = 'Typical for your dates (not a forecast): highs about 7°C, lows about 2°C.\n• Warm coat — lows around 2°C\n• Liquids under 100 ml';
    scriptModel('packing_list', { city: 'Paris' }, worded);
    const res = await ask(trip(winterOffset()), 'What should I pack for Paris?');
    expect(res.body.reply).toBe(worded);
  });

  it('when the weather is unavailable the list says so and still covers plans, travel and plugs', async () => {
    fakeWeather({ met: 'fail', nasa: 'fail', noaa: 'fail' });
    scriptModel('packing_list', { city: null }, 'x 50°C');
    const res = await ask(trip(3), 'What should I bring for the whole trip?');
    expect(res.body.reply).toMatch(/couldn't get the weather for Paris, London/);
    expect(res.body.reply).toMatch(/type G for the UK/);
    expect(res.body.reply).not.toMatch(/°C/);
  });
});

/**
 * POST /api/plan/weather: the same data, per day, for the Calendar and
 * Schedule views. No model call — the numbers are the providers' own.
 */
describe('POST /api/plan/weather (calendar and schedule)', () => {
  const body = (t: any) => ({ origin: { city: t.origin.city }, cities: t.cities.map((c: any) => ({ name: c.name, country: c.country, dates: c.dates })) });

  it('gives each city its own days: forecast where MET Norway reaches, typical beyond, °F for a US home', async () => {
    fakeWeather({ met: metJson((i) => ({ hi: 10 + i, lo: 3, rainMm: i === 1 ? 4.5 : 0, sym: i === 1 ? 'rain' : 'clearsky_day' })), nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    const t = trip(1);
    const res = await request(app).post('/api/plan/weather').send(body(t));
    expect(res.status).toBe(200);
    expect(res.body.fahrenheit).toBe(true);
    const paris = res.body.cities.find((c: any) => c.city === 'Paris');
    expect(paris.days.map((d: any) => d.date)).toEqual([addDays(TODAY, 1), addDays(TODAY, 2), addDays(TODAY, 3)]);
    expect(paris.days[0]).toMatchObject({ kind: 'forecast', summary: 'rain', precipMm: 4.5, highC: 11 });
    expect(paris.days[1]).toMatchObject({ kind: 'forecast', summary: 'sunny' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a trip months away gets typical days, labelled as such, with the years they average', async () => {
    fakeWeather({ met: 'fail', nasa: nasaJson(PARIS_CLIMATE), noaa: 'none' });
    const t = trip(60);
    const res = await request(app).post('/api/plan/weather').send(body(t));
    const paris = res.body.cities.find((c: any) => c.city === 'Paris');
    expect(paris.days.length).toBe(3);
    expect(paris.days.every((d: any) => d.kind === 'typical' && typeof d.wetDayShare === 'number')).toBe(true);
    expect(paris.typicalYears).toBe(`${YEAR - 10}–${YEAR - 1}`);
  });

  it('a day no provider answers for is listed as missing, not guessed', async () => {
    fakeWeather({ met: 'fail', nasa: 'fail', noaa: 'fail' });
    const res = await request(app).post('/api/plan/weather').send(body(trip(1)));
    expect(res.status).toBe(200);
    for (const c of res.body.cities) {
      expect(c.days).toEqual([]);
      expect(c.missing.length).toBeGreaterThan(0);
    }
  });

  it('rejects a body without cities', async () => {
    const res = await request(app).post('/api/plan/weather').send({ origin: { city: 'New York' } });
    expect(res.status).toBe(400);
  });
});
