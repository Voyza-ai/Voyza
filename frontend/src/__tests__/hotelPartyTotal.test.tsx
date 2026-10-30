import './mocks';
import React from 'react';
import { render } from '@testing-library/react';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import { useTripStore } from '@/store/tripStore';
import { hotelsTotal, liveTripTotal } from '@/lib/tripTotals';
import { buildCity, buildTrip } from './fixtures';
import type { Hotel, Trip } from '@/lib/types';

/**
 * A hotel's price is the PARTY total, for every room — never multiplied by a
 * room count on this side.
 *
 * The backend asks Booking for ceil(travelers / 2) rooms, and measured against
 * production Booking's price for `adults:6 rooms:3` is exactly 3.00x the
 * `adults:2 rooms:1` price for the same hotel (13 of 19 Paris rows, 10 of 15
 * London). The number that arrives already covers every room.
 *
 * `tripTotals.ts` and `CityDetailPanel.tsx` carried a `maxGuests` multiplier
 * from before that: `rooms = ceil(travelers / maxGuests)`, then
 * price × rooms. Nothing in either package ever sets `maxGuests` (no producer
 * in the frontend, the backend, the presets or the migrations), so it never
 * ran — but under the party-total model it would triple a six-person stay the
 * moment anything did set it.
 */

const navProps = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };

/**
 * Six travellers, one 3-night stay at $300 a night for all three rooms. The
 * fixture's onward train is kept (the panel renders it) but priced at $0, so
 * the trip total is the stay alone.
 */
function sixInRome(hotel: Hotel): Trip {
  const base = buildCity();
  const rome = buildCity({
    hotel,
    hotels: [hotel],
    selectedHotelIndex: 0,
    transportOut: { ...base.transportOut, price: 0 },
  });
  return buildTrip({ travelers: 6, cities: [rome] });
}

const partyHotel = (extra: Partial<Hotel> = {}): Hotel => ({
  name: 'Mercure Tour Eiffel Grenelle',
  rating: 8.1,
  pricePerNight: 300,
  area: '',
  ...extra,
});

beforeEach(() => {
  useTripStore.setState({ priceMode: 'total' });
});

describe('the trip total adds a stay once, whatever the hotel says about guests', () => {
  it('a hotel carrying maxGuests is not multiplied by a room count', () => {
    const trip = sixInRome(partyHotel({ maxGuests: 2 }));
    expect(hotelsTotal(trip)).toBe(900); // $300 × 3 nights — not × 3 rooms
    expect(liveTripTotal(trip)).toBe(900);
  });

  it('the same stay without maxGuests — the only shape real data has — is unchanged', () => {
    expect(hotelsTotal(sixInRome(partyHotel()))).toBe(900);
  });
});

describe('the city panel shows the party total once', () => {
  it('with maxGuests set, no "× 3 rooms" and no tripled total', () => {
    const trip = sixInRome(partyHotel({ maxGuests: 2 }));
    useTripStore.setState({ currentTrip: trip });
    const { container } = render(<CityDetailPanel trip={trip} cityIndex={0} {...navProps} />);
    const text = container.textContent ?? '';

    // No room MULTIPLIER on the price. The traveller line does name the
    // three rooms the price covers (stayRooms.test.tsx).
    expect(text).not.toMatch(/× 3 rooms/);
    expect(text).not.toContain('$2,700');
    expect(text).toContain('Stay total$900');
  });

  it('without maxGuests renders exactly what it rendered before the multiplier was removed', () => {
    // Every string below was rendered identically by the code with the
    // multiplier, because with `maxGuests` unset it computed one room and
    // every `roomsNeeded > 1` branch was false — except the room count,
    // which now says the 3 rooms the price is for (it said "1 room").
    const trip = sixInRome(partyHotel());
    useTripStore.setState({ currentTrip: trip });
    const { container } = render(<CityDetailPanel trip={trip} cityIndex={0} {...navProps} />);
    const text = container.textContent ?? '';

    expect(text).toContain('Stay total$900· 3 nights');
    expect(text).toContain('6 travelers3 nights · 3 rooms');
    expect(text).toContain('$300/night × 3 nights$900');
    expect(text).toContain('Total$900');
    expect(text).toContain('Per person (6)$150/person');
  });
});
