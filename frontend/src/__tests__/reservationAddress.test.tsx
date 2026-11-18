import './mocks';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import DinnerBadge, { directionsUrl, placeUrl } from '@/components/results/DinnerBadge';
import type { DinnerPlan } from '@/lib/types';

/**
 * Owner request: say "Reservations", not "Dinner plans", and give each one an
 * option to get the restaurant's address.
 */

const plan = (over: Partial<DinnerPlan> = {}): DinnerPlan => ({
  restaurant: 'Septime',
  city: 'Paris',
  partySize: 2,
  status: 'not_booked',
  reserveUrl: 'https://www.google.com/maps/search/?api=1&query=Septime%2C%20Paris',
  reserveVia: 'Google Maps',
  ...over,
});

it('with an address: "Address" shows it with Directions, and does not bubble to the day card', () => {
  const onCard = jest.fn();
  render(
    <div onClick={onCard}>
      <DinnerBadge dinner={plan({ address: '80 Rue de Charonne, 75011 Paris' })} accent="#a33" />
    </div>,
  );
  expect(screen.queryByTestId('reservation-address')).toBeNull();
  fireEvent.click(screen.getByTestId('reservation-address-toggle'));
  expect(screen.getByTestId('reservation-address')).toHaveTextContent('80 Rue de Charonne, 75011 Paris');
  expect(screen.getByTestId('reservation-directions')).toHaveAttribute(
    'href',
    'https://www.google.com/maps/dir/?api=1&destination=Septime%2C%2080%20Rue%20de%20Charonne%2C%2075011%20Paris',
  );
  expect(onCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Hide address'));
  expect(screen.queryByTestId('reservation-address')).toBeNull();
});

it('without an address: "Address" opens the restaurant on the map, where its address is', () => {
  render(<DinnerBadge dinner={plan()} accent="#a33" />);
  expect(screen.getByTestId('reservation-address-map')).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=Septime%2C%20Paris');
});

it('url helpers', () => {
  expect(directionsUrl(plan())).toBe('https://www.google.com/maps/dir/?api=1&destination=Septime%2C%20Paris');
  expect(placeUrl(plan({ address: '1 Rue X, 75001 Paris' }))).toBe('https://www.google.com/maps/search/?api=1&query=Septime%2C%201%20Rue%20X%2C%2075001%20Paris');
});

it('the trip keeps a located restaurant pick\'s address (mergePlaces), so a reservation can reuse it', () => {
  const { mergePlaces } = require('@/store/tripStore');
  const picks = { activities: [{ name: 'Louvre' }], restaurants: [{ name: 'Septime', cuisine: 'Modern French', priceRange: '$$$' }] };
  const out = mergePlaces(picks, [{ name: 'Louvre' }, { name: 'Septime', lat: 48.85, lng: 2.38, placeId: 'google:x', address: '80 Rue de Charonne, 75011 Paris' }]);
  expect(out.restaurants[0]).toMatchObject({ lat: 48.85, address: '80 Rue de Charonne, 75011 Paris' });
});
