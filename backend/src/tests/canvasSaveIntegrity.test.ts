import express from 'express';
import request from 'supertest';

/**
 * POST /api/canvas/:tripId/save — what the save prices, and what it claims.
 *
 * canvasSave.test.ts covers the round trip (what loads must save back
 * unchanged) and the insert-before-delete ordering inside replaceTripGraph.
 * This file covers the rest of the handler, where an audit measured:
 *
 *  - a missing leg re-priced for ONE traveller on a multi-person trip, so
 *    trips.total_cost counted that leg once (640 where 680 is right);
 *  - a hotel-less city searched with `rooms: 1` whatever the party size;
 */

jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

const mockCompareLeg = jest.fn();
jest.mock('../services/compareLeg', () => ({
  compareLeg: (params: any) => mockCompareLeg(params),
}));

const mockSearchHotels = jest.fn();
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: (params: any) => mockSearchHotels(params),
}));

// Same in-memory Supabase as canvasSave.test.ts: per-test table behaviour,
// plus a log of every WRITE in the order it was issued.
type Op = 'select' | 'insert' | 'update' | 'delete';
type TableHandler = (op: Op, payload: any) => { data?: any; error?: any };
const mockTables: Record<string, TableHandler> = {};
const mockWrites: { table: string; op: Op; payload?: any }[] = [];
const mockRpc = jest.fn();

jest.mock('../services/supabase', () => {
  const chain = (table: string) => {
    let op: Op = 'select';
    let payload: any;
    const c: any = {};
    const passthrough = () => c;
    for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'is', 'ilike', 'not', 'in']) {
      c[m] = passthrough;
    }
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
      if (op !== 'select') mockWrites.push({ table, op, payload });
      const handler = mockTables[table];
      return handler ? handler(op, payload) : { data: null, error: null };
    };
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
      rpc: (...args: any[]) => {
        mockWrites.push({ table: `rpc:${args[0]}`, op: 'insert', payload: args[1] });
        return mockRpc(...args);
      },
    }),
  };
});

import canvasRouter from '../routes/canvas';
import { errorHandler } from '../middleware/error';

const app = express();
app.use(express.json());
app.use('/api/canvas', canvasRouter);
app.use(errorHandler);

const city = (name: string, arrival: string, departure: string, extra: Record<string, any> = {}) => ({
  name,
  country: 'Italy',
  dates: { arrival, departure },
  hotel: { name: `${name} Hotel`, pricePerNight: 100, rating: 8, area: '' },
  hotels: [{ name: `${name} Hotel`, pricePerNight: 100, rating: 8, area: '' }],
  activities: ['x'],
  restaurants: [{ name: 'r', cuisine: 'c', priceRange: '$' }],
  ...extra,
});

/** Rome (3 nights) → Florence (3 nights) at $100/night, Rome→Florence by train. */
const twoCityState = (trip: Record<string, any> = { title: 'My edited trip', travelers: 2 }) => ({
  trip,
  cities: [
    city('Rome', '2027-05-01', '2027-05-04', {
      transportOut: { mode: 'train', operator: 'FR', duration: '1h 30m', price: 90, from: 'Rome', to: 'Florence' },
    }),
    city('Florence', '2027-05-04', '2027-05-07'),
  ],
});

const save = (state: any) =>
  request(app).post('/api/canvas/trip-1/save').set('Authorization', 'Bearer owner-token').send({ state });

const tripsUpdate = () => mockWrites.find((w) => w.table === 'trips' && w.op === 'update');

beforeEach(() => {
  mockWrites.length = 0;
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: 2, error: null });
  mockCompareLeg.mockReset();
  mockSearchHotels.mockReset();
  mockSearchHotels.mockResolvedValue([]);
  mockTables.trips = () => ({ data: { id: 'trip-1', user_id: 'owner-user-id' }, error: null });
  mockTables.canvas_sessions = (op) =>
    op === 'select' ? { data: { id: 'session-1' }, error: null } : { data: null, error: null };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('re-pricing a missing leg prices the whole party', () => {
  // A fare that scales with the party, the way Duffel's and trains.ts's do:
  // compareLeg returns PARTY TOTALS for `travelers`.
  const perSeat = 40;
  beforeEach(() => {
    mockCompareLeg.mockImplementation(async (p: any) => ({
      recommendation: 'train',
      trainOption: { price: perSeat * p.travelers, durationMinutes: 90, operator: 'FR' },
      flightOption: null,
    }));
  });

  it('asks compareLeg for the trip party, and the saved leg and total carry the party fare', async () => {
    const state = twoCityState();
    delete (state.cities[0] as any).transportOut; // leg missing → the save re-compares it

    const res = await save(state);
    expect(res.status).toBe(200);

    expect(mockCompareLeg).toHaveBeenCalledTimes(1);
    expect(mockCompareLeg.mock.calls[0][0]).toMatchObject({
      origin: 'Rome',
      destination: 'Florence',
      date: '2027-05-04',
      travelers: 2,
    });
    const [, args] = mockRpc.mock.calls[0];
    expect(args.p_transports[0]).toMatchObject({ mode: 'train', price: 80 });
    // Hotels 100×3 + 100×3, plus the leg for BOTH travellers. Was 640.
    expect(tripsUpdate()?.payload.total_cost).toBe(680);
  });

  it('falls back to one traveller when the state carries no usable party size', async () => {
    for (const travelers of [undefined, 0, -2, 1.5, '2', null]) {
      mockCompareLeg.mockClear();
      const state = twoCityState({ title: 't', travelers });
      delete (state.cities[0] as any).transportOut;
      const res = await save(state);
      expect(res.status).toBe(200);
      expect(mockCompareLeg.mock.calls[0][0].travelers).toBe(1);
    }
  });

  it('leaves a leg that already has a price alone', async () => {
    const res = await save(twoCityState());
    expect(res.status).toBe(200);
    expect(mockCompareLeg).not.toHaveBeenCalled();
    expect(tripsUpdate()?.payload.total_cost).toBe(690);
  });
});

describe('a city saved without hotels is searched with the party in enough rooms', () => {
  const hotellessState = (travelers: number) => {
    const state = twoCityState({ title: 't', travelers });
    (state.cities[1] as any).hotels = [];
    delete (state.cities[1] as any).hotel;
    return state;
  };

  it.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [5, 3],
    [6, 3],
  ])('%i travellers → %i room(s)', async (travelers, rooms) => {
    const res = await save(hotellessState(travelers));
    expect(res.status).toBe(200);
    expect(mockSearchHotels).toHaveBeenCalledTimes(1);
    expect(mockSearchHotels.mock.calls[0][0]).toMatchObject({
      city: 'Florence',
      checkin: '2027-05-04',
      checkout: '2027-05-07',
      adults: travelers,
      rooms,
    });
  });

  it('never sends Booking an undefined room count', async () => {
    await save(hotellessState(4));
    expect(Number.isInteger(mockSearchHotels.mock.calls[0][0].rooms)).toBe(true);
  });
});
