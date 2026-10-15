import express from 'express';
import request from 'supertest';

/**
 * Regression cover for two bugs that could destroy a saved trip while the
 * canvas reported success:
 *
 *  1. The canvas session endpoint had its own DB→frontend mapper that
 *     collapsed `hotels` to one entry, reset the user's hotel pick to 0,
 *     emptied `vibes` and dropped `customHotel`. The save handler then
 *     persisted those defaults — so simply opening a trip on the canvas
 *     and saving it wiped the user's real data. The session must go
 *     through the one canonical mapper (buildTripFromDb) and what it hands
 *     out must round-trip through /save unchanged.
 *
 *  2. The save was a DELETE followed by an INSERT with the insert error
 *     only logged: a failed insert left the trip with no cities and the
 *     client was still told `{ saved: true }`. A failed write must now be
 *     a failed response, and nothing may be deleted ahead of a write that
 *     has not succeeded.
 */

jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

// Per-test table behaviour, plus a log of every WRITE in the order it was
// issued so the tests can assert on ordering (insert before delete).
type Op = 'select' | 'insert' | 'update' | 'delete';
type TableHandler = (op: Op, payload: any) => { data?: any; error?: any };
const mockTables: Record<string, TableHandler> = {};
const mockWrites: { table: string; op: Op; payload?: any; ids?: any }[] = [];
const mockRpc = jest.fn();

jest.mock('../services/supabase', () => {
  const chain = (table: string) => {
    let op: Op = 'select';
    let payload: any;
    let ids: any;
    const c: any = {};
    const passthrough = () => c;
    for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'is', 'ilike', 'not']) {
      c[m] = passthrough;
    }
    c.in = (_col: string, list: any) => {
      ids = list;
      return c;
    };
    c.insert = (p: any) => {
      op = 'insert';
      payload = p;
      return c;
    };
    c.update = (p: any) => {
      op = 'update';
      payload = p;
      return c;
    };
    c.delete = () => {
      op = 'delete';
      return c;
    };
    const run = () => {
      if (op !== 'select') mockWrites.push({ table, op, payload, ids });
      const handler = mockTables[table];
      return handler ? handler(op, payload) : { data: null, error: null };
    };
    // Supports both `await q.single()` and `await q` (no terminal call).
    c.single = () => Promise.resolve(run());
    c.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
    return c;
  };
  return {
    getSupabase: () => ({
      auth: {
        getUser: (token: string) =>
          Promise.resolve({
            data: { user: token === 'owner-token' ? { id: 'owner-user-id' } : null },
          }),
      },
      from: (table: string) => chain(table),
      rpc: (...args: any[]) => mockRpc(...args),
    }),
  };
});

import canvasRouter from '../routes/canvas';
import { errorHandler } from '../middleware/error';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/canvas', canvasRouter);
  app.use(errorHandler);
  return app;
}

// ─── Fixtures: a trip with the exact data the lossy mapper threw away ──
const TRIP = {
  id: 'trip-1',
  user_id: 'owner-user-id',
  title: 'Anniversary Italy Escape',
  total_cost: 1234,
  travelers: 2,
};

const ROME_HOTELS = [
  { name: 'Hotel de Russie', rating: 4.8, pricePerNight: 420, area: 'Piazza del Popolo' },
  { name: 'Hotel Artemide', rating: 4.6, pricePerNight: 210, area: 'Via Nazionale' },
  { name: 'The Fifteen Keys', rating: 4.7, pricePerNight: 180, area: 'Monti' },
];
const ROME_CUSTOM = { name: "Nonna's flat", mode: 'total', amount: 0, area: 'Trastevere' };
const FLORENCE_HOTELS = [
  { name: 'Hotel Lungarno', rating: 4.7, pricePerNight: 390, area: 'Oltrarno' },
  { name: 'Hotel Davanzati', rating: 4.5, pricePerNight: 160, area: 'Centro' },
];

const ROME_ROW = {
  id: 'city-rome',
  trip_id: 'trip-1',
  name: 'Rome',
  country: 'Italy',
  arrival_date: '2027-05-01',
  departure_date: '2027-05-04',
  color_index: 3,
  position: 0,
  hotel: ROME_HOTELS[2],
  hotels: ROME_HOTELS,
  selected_hotel_index: 2,
  custom_hotel: ROME_CUSTOM,
  vibes: ['food', 'art'],
  activities: ['Colosseum at dawn'],
  restaurants: [{ name: 'Da Enzo al 29', cuisine: 'Roman', priceRange: '$$' }],
  schedule: { '2027-05-02': [{ id: 'e1', title: 'Colosseum at dawn', startTime: '07:00', endTime: '09:00' }] },
};
const FLORENCE_ROW = {
  id: 'city-florence',
  trip_id: 'trip-1',
  name: 'Florence',
  country: 'Italy',
  arrival_date: '2027-05-04',
  departure_date: '2027-05-07',
  color_index: 5,
  position: 1,
  hotel: FLORENCE_HOTELS[0],
  hotels: FLORENCE_HOTELS,
  selected_hotel_index: 0,
  custom_hotel: null,
  vibes: ['art'],
  activities: ['Uffizi'],
  restaurants: [{ name: 'Trattoria Mario', cuisine: 'Tuscan', priceRange: '$' }],
  schedule: {},
};
const LEG_ROW = {
  id: 'leg-1',
  trip_id: 'trip-1',
  from_city_id: 'city-rome',
  to_city_id: 'city-florence',
  mode: 'train',
  operator: 'Frecciarossa',
  price: 49,
  duration_minutes: 92,
  depart_time: '09:15',
  arrive_time: '10:47',
  depart_date: '2027-05-04',
  layovers: 0,
  stops: 0,
  currency: 'EUR',
  carrier_code: 'TI',
  flight_number: 'FR 9410',
  alternatives: [{ mode: 'flight', operator: 'ITA', duration: '1h 5m', price: 120 }],
  booking_url: 'https://example.test/book',
};

const app = createApp();

async function loadSession() {
  mockTables.trips = () => ({ data: TRIP });
  mockTables.canvas_sessions = (op, payload) =>
    op === 'insert' ? { data: { id: 'session-1', ...payload } } : { data: null };
  mockTables.cities = () => ({ data: [ROME_ROW, FLORENCE_ROW] });
  mockTables.transports = () => ({ data: [LEG_ROW] });
  const res = await request(app)
    .post('/api/canvas/trip-1/session')
    .set('Authorization', 'Bearer owner-token')
    .send({});
  expect(res.status).toBe(200);
  return res.body.session.state;
}

beforeEach(() => {
  mockWrites.length = 0;
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  mockRpc.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/canvas/:tripId/session — one canonical mapper', () => {
  it('hands the canvas the full hotel list, the pick, the custom stay and the vibes', async () => {
    const state = await loadSession();
    const [rome, florence] = state.cities;

    // The exact fields the old inline mapper defaulted away.
    expect(rome.hotels).toEqual(ROME_HOTELS);
    expect(rome.selectedHotelIndex).toBe(2);
    expect(rome.hotel).toEqual(ROME_HOTELS[2]);
    expect(rome.customHotel).toEqual(ROME_CUSTOM);
    expect(rome.vibes).toEqual(['food', 'art']);
    expect(florence.hotels).toEqual(FLORENCE_HOTELS);
    expect(florence.customHotel).toBeUndefined();

    // Nothing else regressed.
    expect(rome).toMatchObject({
      name: 'Rome',
      country: 'Italy',
      dates: { arrival: '2027-05-01', departure: '2027-05-04' },
      colorIndex: 3,
      activities: ROME_ROW.activities,
      restaurants: ROME_ROW.restaurants,
      schedule: ROME_ROW.schedule,
    });
  });

  it('wires transports by city id with every column, not by array position', async () => {
    const state = await loadSession();
    const [rome, florence] = state.cities;
    expect(rome.transportOut).toMatchObject({
      mode: 'train',
      operator: 'Frecciarossa',
      duration: '1h 32m',
      price: 49,
      from: 'Rome',
      to: 'Florence',
      departTime: '09:15',
      arriveTime: '10:47',
      departDate: '2027-05-04',
      currency: 'EUR',
      carrierCode: 'TI',
      flightNumber: 'FR 9410',
      bookingUrl: 'https://example.test/book',
    });
    expect(rome.transportOut.alternatives).toHaveLength(1);
    expect(florence.transportIn).toEqual(rome.transportOut);
    expect(rome.transportIn).toMatchObject({ mode: 'flight', price: 0 });
  });
});

describe('POST /api/canvas/:tripId/save — what loads must save back unchanged', () => {
  it('persists the hotel list, pick, custom stay and vibes it was handed', async () => {
    const state = await loadSession();
    mockWrites.length = 0;
    mockRpc.mockResolvedValue({ data: 2, error: null });

    const res = await request(app)
      .post('/api/canvas/trip-1/save')
      .set('Authorization', 'Bearer owner-token')
      .send({ state });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('canvas_replace_trip_graph');
    expect(args.p_trip_id).toBe('trip-1');
    expect(args.p_cities[0]).toMatchObject({
      name: 'Rome',
      position: 0,
      hotel: ROME_HOTELS[2],
      hotels: ROME_HOTELS,
      selected_hotel_index: 2,
      custom_hotel: ROME_CUSTOM,
      vibes: ['food', 'art'],
    });
    expect(args.p_cities[1]).toMatchObject({
      name: 'Florence',
      position: 1,
      hotels: FLORENCE_HOTELS,
      selected_hotel_index: 0,
      custom_hotel: null,
      vibes: ['art'],
    });
    expect(args.p_transports).toHaveLength(1);
    expect(args.p_transports[0]).toMatchObject({
      from_position: 0,
      to_position: 1,
      mode: 'train',
      price: 49,
      duration_minutes: 92,
      flight_number: 'FR 9410',
      currency: 'EUR',
    });

    // The atomic path never touches the tables directly.
    expect(mockWrites.filter((w) => w.table === 'cities' || w.table === 'transports')).toEqual([]);
  });

  it('reports a failed write as a failure and deletes nothing', async () => {
    const state = await loadSession();
    mockWrites.length = 0;
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '23502', message: 'null value in column "name" violates not-null constraint' },
    });

    const res = await request(app)
      .post('/api/canvas/trip-1/save')
      .set('Authorization', 'Bearer owner-token')
      .send({ state });
    expect(res.status).toBe(500);
    expect(res.body.saved).toBeUndefined();
    expect(res.body.error).toMatch(/Could not save the trip/);
    expect(mockWrites.filter((w) => w.op === 'delete')).toEqual([]);
  });

  describe('without the DB function (migration 010 not applied)', () => {
    const missingFn = {
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.canvas_replace_trip_graph in the schema cache',
      },
    };

    it('inserts the new cities BEFORE deleting the old ones, then rebuilds transports', async () => {
      const state = await loadSession();
      mockWrites.length = 0;
      mockRpc.mockResolvedValue(missingFn);
      mockTables.cities = (op) => {
        if (op === 'insert') {
          return { data: [{ id: 'new-rome', position: 0 }, { id: 'new-florence', position: 1 }] };
        }
        return { data: [{ id: 'city-rome' }, { id: 'city-florence' }] };
      };
      mockTables.transports = (op) => (op === 'select' ? { data: [{ id: 'leg-1' }] } : { data: null });

      const res = await request(app)
        .post('/api/canvas/trip-1/save')
        .set('Authorization', 'Bearer owner-token')
        .send({ state });
      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(true);

      const seq = mockWrites.map((w) => `${w.table}:${w.op}`);
      expect(seq.indexOf('cities:insert')).toBeGreaterThanOrEqual(0);
      expect(seq.indexOf('cities:insert')).toBeLessThan(seq.indexOf('cities:delete'));
      expect(seq.indexOf('transports:delete')).toBeLessThan(seq.indexOf('cities:delete'));
      expect(seq.indexOf('cities:delete')).toBeLessThan(seq.indexOf('transports:insert'));

      const cityDelete = mockWrites.find((w) => w.table === 'cities' && w.op === 'delete');
      expect(cityDelete?.ids).toEqual(['city-rome', 'city-florence']);
      const legInsert = mockWrites.find((w) => w.table === 'transports' && w.op === 'insert');
      expect(legInsert?.payload).toHaveLength(1);
      expect(legInsert?.payload[0]).toMatchObject({
        trip_id: 'trip-1',
        from_city_id: 'new-rome',
        to_city_id: 'new-florence',
        flight_number: 'FR 9410',
      });
      expect(legInsert?.payload[0].from_position).toBeUndefined();
    });

    it('leaves every existing row alone and fails the request when the insert fails', async () => {
      const state = await loadSession();
      mockWrites.length = 0;
      mockRpc.mockResolvedValue(missingFn);
      mockTables.cities = (op) =>
        op === 'insert'
          ? { data: null, error: { message: 'insert exploded' } }
          : { data: [{ id: 'city-rome' }, { id: 'city-florence' }] };
      mockTables.transports = () => ({ data: [{ id: 'leg-1' }] });

      const res = await request(app)
        .post('/api/canvas/trip-1/save')
        .set('Authorization', 'Bearer owner-token')
        .send({ state });
      expect(res.status).toBe(500);
      expect(res.body.saved).toBeUndefined();
      expect(res.body.error).toMatch(/insert exploded/);
      expect(mockWrites.filter((w) => w.op === 'delete')).toEqual([]);
      expect(mockWrites.filter((w) => w.table === 'transports' && w.op === 'insert')).toEqual([]);
    });
  });
});
