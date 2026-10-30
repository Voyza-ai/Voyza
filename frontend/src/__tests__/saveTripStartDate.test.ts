/**
 * F1 — a saved trip records the day it starts, not the first stay.
 *
 * saveTrip sent `startDate: cities[0].dates.arrival`. Since the first stay
 * starts the day an overnight outbound LANDS, the owner's Jan 10 – 17 trip
 * was saved as starting Jan 11.
 */
jest.mock('@/lib/supabase', () => ({
  getAuthHeader: jest.fn(async () => ({})),
  refreshAuthHeader: jest.fn(async () => null),
}));

import { saveTrip } from '@/lib/api';

const leg = (departDate: string, arriveDate: string) => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 1337,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:10',
  departDate,
  arriveDate,
  stops: 1,
  bookingUrl: null,
});

const trip = (outboundLeg: any, parisArrival = '2027-01-11') => ({
  title: 'Paris → London',
  travelers: 6,
  totalCost: 5215,
  savings: 0,
  cities: [
    { name: 'Paris', dates: { arrival: parisArrival, departure: '2027-01-13' } },
    { name: 'London', dates: { arrival: '2027-01-13', departure: '2027-01-17' } },
  ],
  origin: { city: 'New York', airports: ['JFK'], outboundLeg, returnLeg: null },
});

let sent: any[] = [];
beforeEach(() => {
  sent = [];
  (global as any).fetch = jest.fn(async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 201, json: async () => ({ tripId: 't1', trip: {} }) };
  });
});

describe('saveTrip — startDate', () => {
  it('is the overnight outbound’s departure date', async () => {
    await saveTrip(trip(leg('2027-01-10', '2027-01-11')));
    // Before: '2027-01-11'.
    expect(sent[0].startDate).toBe('2027-01-10');
  });

  it('is the first arrival for a same-day outbound or no outbound, as before', async () => {
    await saveTrip(trip(leg('2027-01-10', '2027-01-10'), '2027-01-10'));
    await saveTrip(trip(null));
    expect(sent.map((b) => b.startDate)).toEqual(['2027-01-10', '2027-01-11']);
  });

  it('still prefers a startDate the trip already carries', async () => {
    await saveTrip({ ...trip(leg('2027-01-10', '2027-01-11')), startDate: '2027-01-09' });
    expect(sent[0].startDate).toBe('2027-01-09');
  });
});
