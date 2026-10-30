/**
 * The detail panel's room count is the one the price is for.
 *
 * The backend prices ceil(adults / 2) rooms for a party of 3+ (services/
 * hotels.ts roomsFor), and the hotel's price covers all of them; the panel
 * said "1 room" for every party. Harness 2026-10-30 (owner trip, 6
 * travellers): "2 nights · 1 room" over a 3-room price.
 *
 * Also pins how taxes & fees render once the backend sends `taxesPerNight`.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import CityDetailPanel, { roomsFor } from '@/components/results/CityDetailPanel';
import { useTripStore } from '@/store/tripStore';
import type { City, Trip } from '@/lib/types';
import { buildCity, buildTrip, mockHotel } from './fixtures';

const panelProps = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };

function tripWith(cities: City[], travelers = 6): Trip {
  return { ...buildTrip(), travelers, cities };
}

beforeEach(() => useTripStore.setState({ priceMode: 'total' }));

describe('room count', () => {
  it('is the backend rule: two adults to a room, one room for 1–2', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(roomsFor)).toEqual([1, 1, 2, 2, 3, 3, 4]);
  });

  it.each([
    [6, '3 rooms'],
    [3, '2 rooms'],
    [2, '1 room'],
    [1, '1 room'],
  ])('%i travellers → "%s" in the detail panel', (travelers, rooms) => {
    const trip = tripWith([buildCity()], travelers);
    useTripStore.setState({ currentTrip: trip });
    render(<CityDetailPanel trip={trip} cityIndex={0} {...panelProps} />);
    expect(screen.getByText(`3 nights · ${rooms}`)).toBeInTheDocument();
  });
});

describe('taxes & fees, when the backend sends them', () => {
  it('render in the breakdown and add up to the total shown', () => {
    const city = buildCity({ hotels: [mockHotel], hotel: mockHotel }); // $95 + $5 taxes, 3 nights
    const trip = tripWith([city], 2);
    useTripStore.setState({ currentTrip: trip });
    render(<CityDetailPanel trip={trip} cityIndex={0} {...panelProps} />);
    expect(screen.getByText('Taxes & fees')).toBeInTheDocument();
    expect(screen.getByText('$15')).toBeInTheDocument();
    expect(screen.getByText('$285')).toBeInTheDocument();
    expect(screen.getAllByText('$300').length).toBeGreaterThan(0);
  });
});
