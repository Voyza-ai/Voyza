/**
 * Saving a texted YES (services/textbot/applier.ts) — home-leg flight swaps
 * only, version-checked. Fake Supabase client; nothing touches a network.
 */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } }));
import { switchHomeLeg, TripProposalApplier } from '../services/textbot/applier';
import { buildTripFromDb } from '../utils/tripShape';
import type { TripLoader } from '../services/textbot/types';
import { FakeSupabase } from './helpers/fakeSupabase';

const TRIP = 'trip-1';
const V1 = '2026-11-28T04:01:38.451859+00:00';
const NOW = Date.parse('2026-11-28T05:00:00Z');

const BA = { price: 535.2, operator: 'British Airways', departDate: '2027-05-27', departTime: '20:07', arriveDate: '2027-05-28', arriveTime: '00:03', originAirport: 'ROM', destAirport: 'PHL', carrierCode: 'BA', stops: 0, durationMinutes: 596, currency: 'USD' };
const IB = { ...BA, price: 553.06, operator: 'Iberia', carrierCode: 'IB' };
const AA = { ...BA, price: 1284.78, operator: 'American Airlines', carrierCode: 'AA', departTime: '11:05', arriveDate: '2027-05-27', arriveTime: '14:45', durationMinutes: 580 };

function seed() {
  const db = new FakeSupabase();
  db.tables.trips = [{
    id: TRIP, user_id: 'owner', title: 'BLUE TEST', travelers: 2, total_cost: 2345, updated_at: V1,
    origin_city: 'Philadelphia', origin_airports: ['PHL'], return_to_home: true,
    outbound_leg: { price: 545.96, operator: 'American Airlines', departDate: '2027-05-15', departTime: '10:50', originAirport: 'PHL', destAirport: 'VCE', carrierCode: 'AA', stops: 0, durationMinutes: 580, currency: 'USD' },
    return_leg: { ...BA, alternatives: [IB, AA] },
  }];
  db.tables.cities = [
    { id: 'c1', trip_id: TRIP, name: 'Venice', country: 'Italy', arrival_date: '2027-05-16', departure_date: '2027-05-22', position: 0, hotel: { name: 'H1', pricePerNight: 119.36 }, hotels: [], selected_hotel_index: 0 },
    { id: 'c2', trip_id: TRIP, name: 'Rome', country: 'Italy', arrival_date: '2027-05-22', departure_date: '2027-05-27', position: 1, hotel: { name: 'H2', pricePerNight: 92.98 }, hotels: [], selected_hotel_index: 0 },
  ];
  db.tables.transports = [{ id: 't1', trip_id: TRIP, from_city_id: 'c1', to_city_id: 'c2', mode: 'train', operator: 'Trenitalia', price: 82.32, depart_time: '18:26' }];
  const trips: TripLoader = {
    async load(id) {
      const t = db.tables.trips.find((r) => r.id === id);
      if (!t) return null;
      return { trip: buildTripFromDb(t, db.tables.cities, db.tables.transports), title: t.title, updatedAt: t.updated_at };
    },
    async members() { return new Map([['owner', 'owner']]); },
  };
  return { db, applier: new TripProposalApplier(trips, db as any, () => NOW) };
}

const choice = (h: any) => ({
  mode: 'flight', operator: h.operator, flightNumber: h.carrierCode, departTime: h.departTime, arriveTime: h.arriveTime,
  departDate: h.departDate, arriveDate: h.arriveDate ?? null, fromAirport: h.originAirport, toAirport: h.destAirport,
  durationMinutes: h.durationMinutes, duration: '', stops: h.stops, price: h.price, currency: 'USD', bookingUrl: null,
});
const proposal = (over: any = {}) => ({
  type: 'proposal',
  reply: 'An earlier flight home: …',
  proposal: {
    kind: 'transport_change', toolName: 'find_transport_option',
    leg: { id: 'Rome→home', kind: 'return', index: 1, from: 'Rome', to: 'Philadelphia', date: '2027-05-27' },
    before: choice(BA), after: choice(AA), request: { relative: 'earlier' }, priceDelta: 749.58, firstStay: null, totals: null,
    ...over,
  },
});

describe('TripProposalApplier (home-leg flight swaps)', () => {
  it('YES on "earlier flight home": AA selected, BA first among alternatives, total + version updated', async () => {
    const { db, applier } = seed();
    expect(await applier.apply(TRIP, proposal() as any, 'owner', V1)).toEqual({ ok: true });
    const t = db.tables.trips[0];
    expect(t.return_leg.operator).toBe('American Airlines');
    expect(t.return_leg.departTime).toBe('11:05');
    expect(t.return_leg.alternatives.map((a: any) => a.operator)).toEqual(['British Airways', 'Iberia']);
    expect(t.return_leg.userChoice).toMatchObject({ source: 'chat', departTime: '11:05', latestDepart: '20:07' });
    // 6×119.36 + 5×92.98 + 82.32 (train) + 545.96 (out) + 1284.78 (new home) = 3094.12 → 3094
    expect(t.total_cost).toBe(3094);
    expect(t.updated_at).toBe(new Date(NOW).toISOString());
    // Nothing else on the trip changed.
    expect(t.outbound_leg.operator).toBe('American Airlines');
    expect(t.outbound_leg.price).toBe(545.96);
    expect(db.tables.cities.map((c) => [c.arrival_date, c.departure_date])).toEqual([['2027-05-16', '2027-05-22'], ['2027-05-22', '2027-05-27']]);
  });

  it('refuses when the trip was saved since the proposal (open website tab) — nothing written', async () => {
    const { db, applier } = seed();
    db.tables.trips[0].updated_at = '2026-11-28T04:30:00+00:00';
    const r = await applier.apply(TRIP, proposal() as any, 'owner', V1);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since I suggested/) });
    expect(db.tables.trips[0].return_leg.operator).toBe('British Airways');
  });

  it('refuses when the leg no longer has the flight the proposal was priced against', async () => {
    const { db, applier } = seed();
    db.tables.trips[0].return_leg = { ...IB, alternatives: [BA, AA] }; // user picked Iberia (same version string kept to isolate this check)
    const r = await applier.apply(TRIP, proposal() as any, 'owner', V1);
    expect(r.ok).toBe(false);
    expect(db.tables.trips[0].return_leg.operator).toBe('Iberia');
  });

  it('race: the trip changes between the read and the write → the versioned UPDATE matches nothing', async () => {
    const { db, applier } = seed();
    const realFrom = db.from.bind(db);
    (db as any).from = (t: string) => {
      if (t === 'trips') db.tables.trips[0].updated_at = 'someone-else-saved';
      return realFrom(t);
    };
    const r = await applier.apply(TRIP, proposal() as any, 'owner', V1);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since/) });
    expect(db.tables.trips[0].return_leg.operator).toBe('British Airways');
  });

  it('inter-city swaps, date-moving outbounds and non-flight proposals are website-only (nothing written)', async () => {
    const { db, applier } = seed();
    const before = JSON.stringify(db.tables);
    const inter = proposal({ leg: { id: 'Venice→Rome', kind: 'intercity', index: 0, from: 'Venice', to: 'Rome', date: '2027-05-22' } });
    expect((await applier.apply(TRIP, inter as any, 'owner', V1)).ok).toBe(false);
    const moves = proposal({ leg: { id: 'home→Venice', kind: 'outbound', index: -1, from: 'Philadelphia', to: 'Venice', date: '2027-05-15' }, firstStay: { city: 'Venice', arrivalBefore: '2027-05-16', arrivalAfter: '2027-05-17', nightsBefore: 6, nightsAfter: 5, hotelDelta: -119.36 } });
    expect(await applier.apply(TRIP, moves as any, 'owner', V1)).toMatchObject({ ok: false, reason: expect.stringMatching(/Venice arrival date/) });
    expect((await applier.apply(TRIP, { type: 'proposal', reply: '', proposal: { kind: 'city_edit' } } as any, 'owner', V1)).ok).toBe(false);
    expect((await applier.apply(TRIP, { type: 'leg_refresh', reply: '' } as any, 'owner', V1)).ok).toBe(false);
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it('switchHomeLeg keeps at most 4 alternatives and never duplicates the chosen one', () => {
    const cur = { ...BA, alternatives: [IB, AA, { ...IB, price: 600 }, { ...IB, price: 700 }] };
    const next = switchHomeLeg(cur, proposal().proposal);
    expect(next.operator).toBe('American Airlines');
    expect(next.alternatives).toHaveLength(4);
    expect(next.alternatives.some((a: any) => a.operator === 'American Airlines')).toBe(false);
    expect(next.alternatives[0].operator).toBe('British Airways');
    expect(next.alternatives[0].alternatives).toBeUndefined();
  });
});
