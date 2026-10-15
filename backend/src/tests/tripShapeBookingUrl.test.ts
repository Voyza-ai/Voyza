import { buildTripFromDb, scrubFabricatedBookingUrl } from '../utils/tripShape';

/**
 * For a while every rail leg was saved with a "booking link" that was really
 * the provider's marketing homepage (All Aboard confirmed they never return
 * one at the search stage). Those trips are still in the database — in
 * transports.booking_url AND inside each row's alternatives JSONB — so the
 * read shape scrubs them, and the UI falls back to its no-link state.
 */
describe('scrubFabricatedBookingUrl', () => {
  it('drops the two homepage links we used to invent', () => {
    expect(scrubFabricatedBookingUrl('https://allaboard.eu')).toBeUndefined();
    expect(scrubFabricatedBookingUrl('https://www.bahn.de/buchung/start')).toBeUndefined();
  });

  it('leaves real links, null and undefined alone', () => {
    expect(scrubFabricatedBookingUrl('https://www.google.com/travel/flights?q=x')).toBe(
      'https://www.google.com/travel/flights?q=x',
    );
    expect(scrubFabricatedBookingUrl(null)).toBeNull();
    expect(scrubFabricatedBookingUrl(undefined)).toBeUndefined();
  });
});

describe('buildTripFromDb scrubs persisted fabricated rail links', () => {
  const trip = { id: 't1', title: 'Rome · Florence', travelers: 2, total_cost: 100 };
  const cities = [
    { id: 'c1', name: 'Rome', country: 'Italy', position: 0, arrival_date: '2026-06-15', departure_date: '2026-06-18' },
    { id: 'c2', name: 'Florence', country: 'Italy', position: 1, arrival_date: '2026-06-18', departure_date: '2026-06-20' },
  ];

  it('nulls the top-level link and the one inside each alternative, keeping real ones', () => {
    const transports = [
      {
        from_city_id: 'c1',
        to_city_id: 'c2',
        mode: 'train',
        operator: 'Trenitalia',
        price: 70,
        booking_url: 'https://allaboard.eu',
        alternatives: [
          { mode: 'train', operator: 'Deutsche Bahn', price: 80, bookingUrl: 'https://www.bahn.de/buchung/start' },
          { mode: 'flight', operator: 'ITA', price: 120, bookingUrl: 'https://www.google.com/travel/flights?q=real' },
        ],
      },
    ];

    const out = buildTripFromDb(trip, cities, transports);
    const leg = out.cities[0].transportOut;

    expect(leg.bookingUrl).toBeUndefined();
    expect(leg.alternatives[0].bookingUrl).toBeUndefined();
    expect(leg.alternatives[1].bookingUrl).toBe('https://www.google.com/travel/flights?q=real');
    // The same object is wired as the next city's transportIn.
    expect(out.cities[1].transportIn.bookingUrl).toBeUndefined();
  });
});
