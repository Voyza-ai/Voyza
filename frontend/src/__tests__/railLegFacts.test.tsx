import './mocks';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import Connector from '@/components/results/Connector';
import { buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import type { Transport } from '@/lib/types';
import {
  pickLegFacts,
  railPriceLabel,
  railPriceShort,
  trainCo2SavingPct,
  formatCo2,
} from '@/lib/legFacts';

const flightD2D = {
  totalMinutes: 300,
  basis: 'city centre to city centre',
  parts: [
    { kind: 'transfer' as const, label: 'City centre → MUC', minutes: 75 },
    { kind: 'airport' as const, label: 'Check-in, security & boarding', minutes: 90 },
    { kind: 'flight' as const, label: 'Flight', minutes: 80 },
    { kind: 'transfer' as const, label: 'BER → city centre', minutes: 55 },
  ],
};

const train: Transport = {
  mode: 'train',
  operator: 'Deutsche Bahn',
  duration: '4h',
  price: 60,
  from: 'Munich',
  to: 'Berlin',
  departTime: '08:00',
  arriveTime: '12:00',
  departDate: '2026-12-10',
  layovers: 0,
  doorToDoor: { totalMinutes: 240, basis: 'city centre to city centre', parts: [{ kind: 'train', label: 'Train, station to station', minutes: 240 }] },
  co2: { kg: 21.4, source: 'estimate', distanceKm: 604, gramsPerPassengerKm: 35.46 },
  priceSource: { kind: 'live', provider: 'All Aboard', testApi: true },
};

const flight: Transport = {
  mode: 'flight',
  operator: 'Lufthansa',
  duration: '1h 20m',
  price: 140,
  from: 'Munich',
  to: 'Berlin',
  departTime: '09:00',
  arriveTime: '10:20',
  departDate: '2026-12-10',
  layovers: 0,
  bookingUrl: 'https://example.com',
  doorToDoor: flightD2D,
  co2: { kg: 113, source: 'duffel' },
};

const props = { index: 0, cityIndex: 0, isExpanded: true, onToggle: jest.fn() };

beforeEach(() => {
  useTripStore.setState({ currentTrip: buildTrip(), priceMode: 'total' });
});

describe('lib/legFacts', () => {
  test('pickLegFacts carries only the facts present, and a price source only for rail', () => {
    expect(pickLegFacts({}, 'train')).toEqual({});
    expect(pickLegFacts(null, 'flight')).toEqual({});
    expect(pickLegFacts({ co2: { kg: 0, source: 'duffel' } }, 'flight')).toEqual({});
    expect(pickLegFacts({ priceSource: { kind: 'live' } }, 'flight')).toEqual({});
    expect(pickLegFacts({ priceSource: { kind: 'live' }, doorToDoor: flightD2D }, 'train')).toEqual({
      priceSource: { kind: 'live' },
      doorToDoor: flightD2D,
    });
  });

  test('CO₂ saving is a whole percent, only when the train is lower', () => {
    expect(trainCo2SavingPct({ kg: 21.4, source: 'estimate' }, { kg: 113, source: 'duffel' })).toBe(81);
    expect(trainCo2SavingPct({ kg: 120, source: 'estimate' }, { kg: 113, source: 'duffel' })).toBeNull();
    expect(trainCo2SavingPct(null, { kg: 113, source: 'duffel' })).toBeNull();
    expect(formatCo2(21.4)).toBe('21 kg');
    expect(formatCo2(0.2)).toBe('1 kg');
  });

  test('"live" only for a provider fare; every other source says what it is', () => {
    expect(railPriceLabel({ kind: 'live', provider: 'Deutsche Bahn' }).text).toBe('Live fare · Deutsche Bahn');
    expect(railPriceLabel({ kind: 'live', provider: 'All Aboard', testApi: true }).text).toBe('Live fare · All Aboard (test API)');
    expect(railPriceLabel({ kind: 'cached' }).text).not.toMatch(/live/i);
    expect(railPriceLabel({ kind: 'estimated' }).text).toBe('Estimated fare');
    expect(railPriceLabel(undefined).text).not.toMatch(/live/i);
    expect(railPriceShort({ kind: 'estimated' })).toBe('Est. fare');
    expect(railPriceShort(undefined)).toBeNull();
  });
});

describe('Connector — rail leg facts', () => {
  test('a train leg with a flight alternative shows both door-to-door times, CO₂ and the saving', () => {
    render(<Connector transport={{ ...train, alternatives: [flight] }} {...props} />);
    const d2d = screen.getByTestId('door-to-door');
    const t = within(d2d).getByTestId('d2d-train');
    const f = within(d2d).getByTestId('d2d-flight');
    expect(t).toHaveTextContent('Train 4h city centre to city centre');
    expect(t).toHaveTextContent('≈ 21 kg CO₂');
    expect(t).toHaveTextContent('estimate: ~604 km × 35 g/passenger-km');
    expect(f).toHaveTextContent('Flight 5h incl. airport transfers, security & boarding');
    expect(f).toHaveTextContent('1h 15m City centre → MUC · 1h 30m Check-in, security & boarding · 55m BER → city centre');
    expect(f).toHaveTextContent('airline itinerary estimate (Duffel)');
    expect(screen.getByTestId('co2-saving')).toHaveTextContent('Train saves ~81% CO₂ on this leg (estimate)');
  });

  test('the rail price says where it came from, and the booking slot is not a control', () => {
    render(<Connector transport={train} {...props} />);
    expect(screen.getByTestId('rail-price-source')).toHaveTextContent('Live fare · All Aboard (test API)');
    const slot = screen.getByTestId('rail-booking-slot');
    expect(slot).toHaveTextContent('Rail partner booking');
    expect(slot).toHaveTextContent('coming soon');
    expect(slot.tagName).not.toBe('BUTTON');
    expect(slot.closest('a')).toBeNull();
    expect(screen.queryByRole('button', { name: /book/i })).toBeNull();
  });

  test('a train without a recorded source never claims live', () => {
    const { priceSource: _drop, ...legacy } = train;
    render(<Connector transport={legacy} {...props} />);
    expect(screen.getByTestId('rail-price-source')).toHaveTextContent('Fare source not recorded');
  });

  test('a flight-only leg shows its own door-to-door line and no saving', () => {
    render(<Connector transport={flight} {...props} />);
    expect(screen.getByTestId('d2d-flight')).toBeInTheDocument();
    expect(screen.queryByTestId('d2d-train')).toBeNull();
    expect(screen.queryByTestId('co2-saving')).toBeNull();
    expect(screen.queryByTestId('rail-price-source')).toBeNull();
    expect(screen.queryByTestId('rail-booking-slot')).toBeNull();
  });

  test('a leg priced before these facts existed renders no section at all', () => {
    const { doorToDoor: _d, co2: _c, ...old } = flight;
    render(<Connector transport={old} {...props} />);
    expect(screen.queryByTestId('door-to-door')).toBeNull();
  });

  test('the collapsed train chip names the fare source instead of the generic hint', () => {
    render(<Connector transport={train} {...props} isExpanded={false} />);
    expect(screen.getByText('Live fare')).toBeInTheDocument();
  });
});

describe('leg options → Transport carry the facts', () => {
  test('cityEdit legToTransport keeps door-to-door, CO₂ and the rail price source', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { legToTransport } = require('@/lib/cityEdit');
    const t = legToTransport(
      [
        { mode: 'train', operator: 'DB', price: 60, currency: 'USD', departTime: '08:00', arriveTime: '12:00', duration: '4h', durationMinutes: 240, priceDelta: 0, doorToDoor: train.doorToDoor, co2: train.co2, priceSource: train.priceSource },
        { mode: 'flight', operator: 'LH', price: 140, currency: 'USD', departTime: '09:00', arriveTime: '10:20', duration: '1h 20m', durationMinutes: 80, priceDelta: 80, doorToDoor: flightD2D, co2: flight.co2 },
      ],
      'Munich',
      'Berlin',
      '2026-12-10',
    );
    expect(t.priceSource).toEqual(train.priceSource);
    expect(t.co2).toEqual(train.co2);
    expect(t.alternatives[0].doorToDoor).toEqual(flightD2D);
    expect(t.alternatives[0].priceSource).toBeUndefined();
  });
});
