/**
 * A proposal text shows what YES changes — dates, new legs, trip total —
 * computed with the website's own functions (services/textbot/proposalSummary.ts).
 * Also: a long proposal never loses its "Reply YES" line to trimming.
 */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } }));
import { proposalImpact } from '../services/textbot/proposalSummary';
import { buildTripFromDb } from '../utils/tripShape';
import { TextBot } from '../services/textbot/bot';
import { MemoryTextStore } from '../services/textbot/store';
import { SimulatorProvider } from '../services/textbot/providers/simulator';

const BA = { price: 535.2, operator: 'British Airways', departDate: '2027-05-27', departTime: '20:07', originAirport: 'ROM', destAirport: 'PHL', stops: 0, durationMinutes: 596, currency: 'USD' };
const OUT = { price: 545.96, operator: 'American Airlines', departDate: '2027-05-15', departTime: '10:50', originAirport: 'PHL', destAirport: 'VCE', stops: 0, durationMinutes: 580, currency: 'USD' };
const trip = () =>
  buildTripFromDb(
    { id: 't', title: 'Venice → Rome', travelers: 2, origin_city: 'Philadelphia', origin_airports: ['PHL'], return_to_home: true, outbound_leg: OUT, return_leg: BA },
    [
      { id: 'c1', name: 'Venice', country: 'Italy', arrival_date: '2027-05-16', departure_date: '2027-05-22', position: 0, hotel: { name: 'H1', pricePerNight: 119.36 }, hotels: [{ name: 'H1', pricePerNight: 119.36 }], selected_hotel_index: 0 },
      { id: 'c2', name: 'Rome', country: 'Italy', arrival_date: '2027-05-22', departure_date: '2027-05-27', position: 1, hotel: { name: 'H2', pricePerNight: 92.98 }, hotels: [{ name: 'H2', pricePerNight: 92.98 }], selected_hotel_index: 0 },
    ],
    [{ id: 'x', from_city_id: 'c1', to_city_id: 'c2', mode: 'train', operator: 'Trenitalia', price: 82.32, depart_time: '18:26' }],
  );

const addFlorence = {
  type: 'proposal',
  reply: "Here's your trip with Florence added after Venice. Florence adds 2 nights after Venice, so Rome moves 2 days later.",
  proposal: {
    kind: 'city_edit', toolName: 'add_city', op: { kind: 'add', city: 'Florence', afterCity: 'Venice', nights: 2 },
    before: [{ name: 'Venice', arrival: '2027-05-16', departure: '2027-05-22' }, { name: 'Rome', arrival: '2027-05-22', departure: '2027-05-27' }],
    after: [
      { name: 'Venice', arrival: '2027-05-16', departure: '2027-05-22', status: 'kept' },
      { name: 'Florence', arrival: '2027-05-22', departure: '2027-05-24', status: 'added', hotels: [{ name: 'Arno', rating: 9, pricePerNight: 140 }] },
      { name: 'Rome', arrival: '2027-05-24', departure: '2027-05-29', status: 'moved' },
    ],
    removed: [],
    legs: [
      { index: 0, from: 'Venice', to: 'Florence', date: '2027-05-22', options: [{ mode: 'train', operator: 'Trenitalia', price: 50.13, durationMinutes: 133, departTime: '09:26' }] },
      { index: 1, from: 'Florence', to: 'Rome', date: '2027-05-24', options: [] },
    ],
    returnLeg: { ...BA, departDate: '2027-05-29' },
  },
};

describe('proposalImpact', () => {
  it('city edit: new stays, each new leg, and the total before → after', () => {
    const out = proposalImpact(trip(), addFlorence, addFlorence.reply);
    // before: 6×119.36 + 5×92.98 + 82.32 + 545.96 + 535.20 = 2344.54 → $2,345
    // after:  716.16 + 2×140 + 5×92.98 (Rome kept its hotel, new dates) + 50.13 + 0 (no Florence→Rome yet) + 545.96 + 535.20 = 2592.35 → $2,592
    expect(out).toBe(
      'Trip: Venice May 16–May 22, Florence May 22–May 24, Rome May 24–May 29.\n' +
        'Venice → Florence: train Trenitalia $50.\n' +
        'Florence → Rome: nothing found yet.\n' +
        'Trip total $2,345 → $2,592 (+$247).',
    );
  });

  it('date shift: the new stays and total from proposedTrip', () => {
    const t = trip();
    const proposedTrip = { ...t, cities: [{ ...t.cities[0], dates: { arrival: '2027-05-16', departure: '2027-05-20' } }, { ...t.cities[1], dates: { arrival: '2027-05-20', departure: '2027-05-27' } }] };
    const out = proposalImpact(t, { type: 'proposal', proposal: { kind: 'date_shift', proposedTrip } }, 'Pinned Venice.');
    // 4×119.36 + 7×92.98 + 82.32 + 545.96 + 535.20 = 2291.78 → $2,292
    expect(out).toBe('Trip: Venice May 16–May 20, Rome May 20–May 27.\nTrip total $2,345 → $2,292 (-$53).');
  });

  it('adds nothing when the reply already states the total (transport changes)', () => {
    expect(proposalImpact(trip(), { type: 'proposal', proposal: { kind: 'transport_change' } }, 'Trip total $2,843 → $2,842 (−$1).')).toBe('');
  });

  it('never throws on an odd proposal', () => {
    expect(proposalImpact(trip(), { type: 'proposal', proposal: { kind: 'city_edit', after: 'nonsense' } }, 'x')).toBe('');
  });
});

describe('a long proposal keeps its YES line', () => {
  it('trims the description, not the ask', async () => {
    const store = new MemoryTextStore();
    const provider = new SimulatorProvider();
    const long = { ...addFlorence, reply: 'Here is a very long explanation. '.repeat(60) };
    const bot = new TextBot({
      store, provider, applier: null,
      chat: { run: async () => long as any },
      trips: { load: async () => ({ trip: trip(), title: 'T', updatedAt: 'v1' }), members: async () => new Map([['u1', 'owner']]) },
    });
    const c = await store.createCode('link', 't', 'u1');
    await bot.handle({ provider: 'simulator', threadId: 'dm', from: '+12155550001', participants: [], text: `link ${c.code}`, providerMessageId: '1', receivedAt: '' });
    const out = await bot.handle({ provider: 'simulator', threadId: 'dm', from: '+12155550001', participants: [], text: 'add Florence', providerMessageId: '2', receivedAt: '' });
    expect(out[0].length).toBeLessThanOrEqual(900);
    expect(out[0]).toMatch(/Reply YES to apply \(the trip owner\) or NO to drop it\. Expires in 10 min\.$/);
  });
});
