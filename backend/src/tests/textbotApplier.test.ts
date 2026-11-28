/**
 * Saving a texted YES (services/textbot/applier.ts): every proposal kind,
 * applied with the website's own functions (bundled from frontend/lib) and
 * handed to the website's own save. Fake Supabase; the save is captured, not run.
 */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } }));
import { TripProposalApplier } from '../services/textbot/applier';
import { buildTripFromDb } from '../utils/tripShape';
import type { TripLoader } from '../services/textbot/types';
import { FakeSupabase } from './helpers/fakeSupabase';

const TRIP = 'trip-1';
const V1 = '2026-11-28T04:01:38.451859+00:00';
const NOW = Date.parse('2026-11-28T05:00:00Z');

const BA = { price: 535.2, operator: 'British Airways', departDate: '2027-05-27', departTime: '20:07', arriveDate: '2027-05-28', arriveTime: '00:03', originAirport: 'ROM', destAirport: 'PHL', carrierCode: 'BA', stops: 0, durationMinutes: 596, currency: 'USD' };
const IB = { ...BA, price: 553.06, operator: 'Iberia', carrierCode: 'IB' };
const AA = { ...BA, price: 1284.78, operator: 'American Airlines', carrierCode: 'AA', departTime: '11:05', arriveDate: '2027-05-27', arriveTime: '14:45', durationMinutes: 580 };
const OUT = { price: 545.96, operator: 'American Airlines', departDate: '2027-05-15', departTime: '10:50', arriveDate: '2027-05-16', arriveTime: '02:30', originAirport: 'PHL', destAirport: 'VCE', carrierCode: 'AA', stops: 0, durationMinutes: 580, currency: 'USD' };

function seed() {
  const db = new FakeSupabase();
  db.tables.trips = [{
    id: TRIP, user_id: 'owner', title: 'Venice → Rome', travelers: 2, total_cost: 2345, updated_at: V1,
    origin_city: 'Philadelphia', origin_airports: ['PHL'], return_to_home: true,
    outbound_leg: OUT, return_leg: { ...BA, alternatives: [IB, AA] },
  }];
  db.tables.cities = [
    { id: 'c1', trip_id: TRIP, name: 'Venice', country: 'Italy', arrival_date: '2027-05-16', departure_date: '2027-05-22', position: 0, hotel: { name: 'H1', pricePerNight: 119.36 }, hotels: [{ name: 'H1', pricePerNight: 119.36 }], selected_hotel_index: 0, activities: ['Rialto'], schedule: {} },
    { id: 'c2', trip_id: TRIP, name: 'Rome', country: 'Italy', arrival_date: '2027-05-22', departure_date: '2027-05-27', position: 1, hotel: { name: 'H2', pricePerNight: 92.98 }, hotels: [{ name: 'H2', pricePerNight: 92.98 }], selected_hotel_index: 0, activities: ['Colosseum'], schedule: {} },
  ];
  db.tables.transports = [{ id: 't1', trip_id: TRIP, from_city_id: 'c1', to_city_id: 'c2', mode: 'train', operator: 'Trenitalia', price: 82.32, depart_time: '18:26', arrive_time: '22:25', duration_minutes: 239 }];
  db.tables.canvas_sessions = [{ id: 's1', trip_id: TRIP, saved_at: '2026-11-20T00:00:00Z', state: { layout: { zoom: 1.2 }, trip: { title: 'Venice → Rome', note: 'kept' } } }];
  const trips: TripLoader = {
    async load(id) {
      const t = db.tables.trips.find((r) => r.id === id);
      if (!t) return null;
      const full: any = buildTripFromDb(t, db.tables.cities, db.tables.transports);
      return { trip: full, title: t.title, updatedAt: t.updated_at };
    },
    async members() { return new Map([['owner', 'owner']]); },
  };
  const saves: Array<{ tripId: string; state: any; by: string }> = [];
  let failSave = false;
  const applier = new TripProposalApplier(trips, db as any, () => NOW, async (tripId, state, by) => {
    if (failSave) throw new Error('graph write failed');
    saves.push({ tripId, state, by });
    return new Date(NOW).toISOString();
  });
  return { db, applier, saves, failSave: () => { failSave = true; } };
}

const choice = (h: any, mode: 'flight' | 'train' = 'flight') => ({
  optionId: 'x', mode, operator: h.operator, flightNumber: h.carrierCode ?? null, departTime: h.departTime ?? null, arriveTime: h.arriveTime ?? null,
  departDate: h.departDate ?? null, arriveDate: h.arriveDate ?? null, fromAirport: h.originAirport ?? null, toAirport: h.destAirport ?? null,
  durationMinutes: h.durationMinutes ?? 0, duration: '', stops: h.stops ?? 0, price: h.price, currency: 'USD', bookingUrl: null,
});
const homeSwap = (over: any = {}) => ({
  type: 'proposal', reply: 'An earlier flight home…',
  proposal: {
    kind: 'transport_change', toolName: 'find_transport_option',
    leg: { id: 'Rome→home', kind: 'return', index: 1, from: 'Rome', to: 'Philadelphia', date: '2027-05-27' },
    before: choice(BA), after: choice(AA), request: { relative: 'earlier' }, priceDelta: 749.58, firstStay: null, totals: null,
    ...over,
  },
});

describe('TripProposalApplier', () => {
  it('flight home: the website functions switch it; the state handed to the save has it; version claimed first', async () => {
    const { db, applier, saves } = seed();
    expect(await applier.apply(TRIP, homeSwap() as any, 'owner', V1)).toEqual({ ok: true });
    expect(db.tables.trips[0].updated_at).toBe(new Date(NOW).toISOString()); // claimed
    expect(saves).toHaveLength(1);
    const s = saves[0].state;
    expect(s.trip.origin.returnLeg.operator).toBe('American Airlines');
    expect(s.trip.origin.returnLeg.alternatives.map((a: any) => a.operator)).toEqual(['British Airways', 'Iberia']);
    expect(s.trip.origin.returnLeg.userChoice).toMatchObject({ source: 'chat', latestDepart: '20:07' });
    expect(s.trip.origin.outboundLeg.price).toBe(545.96);
    expect(s.cities.map((c: any) => [c.name, c.dates.arrival, c.dates.departure])).toEqual([
      ['Venice', '2027-05-16', '2027-05-22'], ['Rome', '2027-05-22', '2027-05-27'],
    ]);
    // The canvas session's other fields survive, as with persistSavedTrip.
    expect(s.layout).toEqual({ zoom: 1.2 });
    expect(s.trip.note).toBe('kept');
    expect(saves[0].by).toBe('owner');
  });

  it('train between cities: the Venice → Rome leg switches, mirrored on Rome’s transportIn', async () => {
    const { applier, saves } = seed();
    const trenitalia = { operator: 'Trenitalia', departTime: '18:26', arriveTime: '22:25', price: 82.32, departDate: '2027-05-22' };
    const italo = { operator: 'Italo', departTime: '09:15', arriveTime: '13:05', price: 64, departDate: '2027-05-22', durationMinutes: 230 };
    const r = await applier.apply(TRIP, {
      type: 'proposal', reply: 'A cheaper train…',
      proposal: {
        kind: 'transport_change', toolName: 'find_transport_option',
        leg: { id: 'Venice→Rome', kind: 'intercity', index: 0, from: 'Venice', to: 'Rome', date: '2027-05-22' },
        before: choice(trenitalia, 'train'), after: choice(italo, 'train'), request: { relative: 'cheaper' }, priceDelta: -18.32, firstStay: null, totals: null,
      },
    } as any, 'owner', V1);
    expect(r).toEqual({ ok: true });
    const s = saves[0].state;
    expect(s.cities[0].transportOut).toMatchObject({ mode: 'train', operator: 'Italo', price: 64, departTime: '09:15' });
    expect(s.cities[0].transportOut.alternatives[0]).toMatchObject({ operator: 'Trenitalia', price: 82.32 });
    expect(s.cities[1].transportIn).toMatchObject({ operator: 'Italo', price: 64 });
  });

  it('city edit (add Florence for 2 nights): new city, hotels, legs, home flight and title, via applyCityEdit', async () => {
    const { applier, saves } = seed();
    const hotel = (name: string, p: number) => ({ name, rating: 8.5, pricePerNight: p, reviewCount: 100, bookingUrl: null });
    const opt = (price: number) => ({ mode: 'train', operator: 'Italo', price, duration: '2h', durationMinutes: 120, departTime: '10:00', arriveTime: '12:00', stops: 0, bookingUrl: null, flightNumber: null });
    const r = await applier.apply(TRIP, {
      type: 'proposal', reply: "Here's your trip with Florence added after Venice.",
      proposal: {
        kind: 'city_edit', toolName: 'add_city',
        op: { kind: 'add', city: 'Florence', afterCity: 'Venice', nights: 2 },
        before: [{ name: 'Venice', arrival: '2027-05-16', departure: '2027-05-22' }, { name: 'Rome', arrival: '2027-05-22', departure: '2027-05-27' }],
        after: [
          { name: 'Venice', arrival: '2027-05-16', departure: '2027-05-22', status: 'kept' },
          { name: 'Florence', arrival: '2027-05-22', departure: '2027-05-24', status: 'added', hotels: [hotel('Arno Rooms', 140)] },
          { name: 'Rome', arrival: '2027-05-24', departure: '2027-05-29', status: 'moved', hotels: [hotel('H2', 95)] },
        ],
        removed: [],
        legs: [{ index: 0, from: 'Venice', to: 'Florence', date: '2027-05-22', options: [opt(45)] }, { index: 1, from: 'Florence', to: 'Rome', date: '2027-05-24', options: [opt(30)] }],
        returnLeg: { ...BA, departDate: '2027-05-29', price: 560 },
        note: 'Florence adds 2 nights, so you fly home 2 days later.',
      },
    } as any, 'owner', V1);
    expect(r).toEqual({ ok: true });
    const s = saves[0].state;
    expect(s.cities.map((c: any) => [c.name, c.dates.arrival, c.dates.departure])).toEqual([
      ['Venice', '2027-05-16', '2027-05-22'], ['Florence', '2027-05-22', '2027-05-24'], ['Rome', '2027-05-24', '2027-05-29'],
    ]);
    expect(s.cities[1].hotel.name).toBe('Arno Rooms');
    expect(s.cities[0].transportOut).toMatchObject({ operator: 'Italo', price: 45, to: 'Florence' });
    expect(s.cities[1].transportOut).toMatchObject({ price: 30, to: 'Rome' });
    expect(s.cities[2].hotel.name).toBe('H2'); // the pick kept by name, re-priced
    expect(s.cities[2].hotel.pricePerNight).toBe(95);
    expect(s.trip.origin.returnLeg.departDate).toBe('2027-05-29');
    expect(s.trip.title).toBe('Venice → Florence → Rome');
  });

  it('date shift: the proposal’s proposedTrip is what gets saved (as the website applies it)', async () => {
    const { applier, saves } = seed();
    const proposedTrip = { title: 'Venice → Rome', travelers: 2, cities: [{ name: 'Venice', dates: { arrival: '2027-05-16', departure: '2027-05-20' } }, { name: 'Rome', dates: { arrival: '2027-05-20', departure: '2027-05-27' } }], origin: { city: 'Philadelphia', outboundLeg: OUT, returnLeg: BA }, returnToHome: true };
    expect(await applier.apply(TRIP, { type: 'proposal', reply: '', proposal: { kind: 'date_shift', proposedTrip } } as any, 'owner', V1)).toEqual({ ok: true });
    expect(saves[0].state.cities.map((c: any) => c.dates.departure)).toEqual(['2027-05-20', '2027-05-27']);
  });

  it('trip saved since the proposal → refused, nothing claimed, nothing saved', async () => {
    const { db, applier, saves } = seed();
    db.tables.trips[0].updated_at = '2026-11-28T04:30:00+00:00';
    expect(await applier.apply(TRIP, homeSwap() as any, 'owner', V1)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since/) });
    expect(saves).toHaveLength(0);
    expect(db.tables.trips[0].updated_at).toBe('2026-11-28T04:30:00+00:00');
  });

  it('the leg no longer has the priced flight → refused, nothing saved', async () => {
    const { db, applier, saves } = seed();
    db.tables.trips[0].return_leg = { ...IB, alternatives: [BA, AA] };
    expect((await applier.apply(TRIP, homeSwap() as any, 'owner', V1)).ok).toBe(false);
    expect(saves).toHaveLength(0);
  });

  it('race: the trip changes between the read and the claim → refused, nothing saved', async () => {
    const { db, applier, saves } = seed();
    const realFrom = db.from.bind(db);
    (db as any).from = (t: string) => {
      if (t === 'trips') db.tables.trips[0].updated_at = 'someone-else-saved';
      return realFrom(t);
    };
    expect(await applier.apply(TRIP, homeSwap() as any, 'owner', V1)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since/) });
    expect(saves).toHaveLength(0);
  });

  it('a failing save is reported, not claimed as done', async () => {
    const env = seed();
    env.failSave();
    expect(await env.applier.apply(TRIP, homeSwap() as any, 'owner', V1)).toMatchObject({ ok: false, reason: expect.stringMatching(/saving failed part-way/) });
  });

  it('unknown result types write nothing', async () => {
    const { db, applier, saves } = seed();
    const before = JSON.stringify(db.tables);
    expect((await applier.apply(TRIP, { type: 'leg_refresh', reply: '' } as any, 'owner', V1)).ok).toBe(false);
    expect((await applier.apply(TRIP, { type: 'proposal', reply: '', proposal: { kind: 'mystery' } } as any, 'owner', V1)).ok).toBe(false);
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(saves).toHaveLength(0);
  });
});
