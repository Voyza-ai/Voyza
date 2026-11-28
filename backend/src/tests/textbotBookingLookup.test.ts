/**
 * BookingStoreLookup (services/textbot/runtime.ts): which legs count as booked
 * for "unbooked leg" / "leave now" nudges. bookingStore is mocked.
 */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', PORT: 4000 } }));
const recs: any[] = [];
jest.mock('../services/bookingStore', () => ({ listBookings: jest.fn(async (uid: string) => recs.filter((r) => r.user_id === uid)) }));

import { BookingStoreLookup } from '../services/textbot/runtime';
import type { NudgeLeg } from '../services/textbot/nudges';

const trips = {
  load: async () => null,
  members: async () => new Map<string, 'owner' | 'editor' | 'viewer'>([['owner-1', 'owner'], ['friend', 'editor']]),
};
const leg = (over: Partial<NudgeLeg> = {}): NudgeLeg => ({
  id: 'home→Venice', kind: 'outbound', from: 'Philadelphia', to: 'Venice', departCity: 'Philadelphia', departCountry: null,
  mode: 'flight', operator: 'AA', departDate: '2027-05-15', departTime: '10:50', fromAirport: 'PHL', ...over,
});
const booking = (over: any = {}) => ({
  user_id: 'owner-1', trip_id: 'trip-1', status: 'confirmed',
  slices: [{ origin: 'PHL', destination: 'VCE', departingAt: '2027-05-15T10:50:00' }], ...over,
});

describe('BookingStoreLookup', () => {
  beforeEach(() => { recs.length = 0; });
  const lookup = new BookingStoreLookup(trips as any);

  it('a confirmed booking for this trip, same date and airport → booked', async () => {
    recs.push(booking());
    expect(await lookup.isBooked('trip-1', leg())).toBe(true);
  });

  it('pending/failed bookings, another trip, another date or airport → not booked', async () => {
    recs.push(booking({ status: 'payment_pending' }), booking({ trip_id: 'trip-2' }),
      booking({ slices: [{ origin: 'PHL', departingAt: '2027-05-16T09:00:00' }] }),
      booking({ slices: [{ origin: 'JFK', departingAt: '2027-05-15T10:50:00' }] }));
    expect(await lookup.isBooked('trip-1', leg())).toBe(false);
  });

  it("a friend's booking doesn't count (bookings are looked up for the trip owner)", async () => {
    recs.push(booking({ user_id: 'friend' }));
    expect(await lookup.isBooked('trip-1', leg())).toBe(false);
  });

  it('trains are never "booked" (no in-app rail booking yet)', async () => {
    recs.push(booking());
    expect(await lookup.isBooked('trip-1', leg({ mode: 'train' }))).toBe(false);
  });
});
