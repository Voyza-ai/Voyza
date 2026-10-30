import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useTripStore } from '@/store/tripStore';
import { planChat, LegOption, LegRefresh } from '@/lib/api';
import { buildCity, buildTrip } from './fixtures';
import type { Transport, Trip } from '@/lib/types';

/**
 * A chat leg refresh must land on THE leg it priced.
 *
 * applyLegRefreshToTrip found the two ends with two independent findIndex
 * calls. On a trip that visits a city twice — Rome → Florence → Rome — a
 * refresh of Florence → Rome took the FIRST Rome as the arrival, so the new
 * train was mirrored onto the trip's opening Rome while the Rome it actually
 * arrives at kept the old one. And a pair that is not a leg at all (Rome →
 * Venice when they are not adjacent) was patched anyway.
 *
 * The backend now resolves a leg as the first CONSECUTIVE pair
 * (plan.ts findTripLeg); the client has to pick the same pair.
 */

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;

const transport = (from: string, to: string, extra: Partial<Transport> = {}): Transport => ({
  mode: 'train',
  operator: 'Old operator',
  duration: '1h 30m',
  price: 40,
  from,
  to,
  departTime: '08:00',
  arriveTime: '09:30',
  ...extra,
});

const option = (extra: Partial<LegOption> = {}): LegOption => ({
  mode: 'train',
  operator: 'Italo',
  flightNumber: 'IT 9921',
  price: 29,
  currency: 'USD',
  departTime: '10:15',
  arriveTime: '11:50',
  duration: '1h 35m',
  durationMinutes: 95,
  stops: 0,
  bookingUrl: null,
  priceDelta: -11,
  ...extra,
});

/** Rome (Jun 15–18) → Florence (Jun 18–20) → Rome (Jun 20–22). */
function repeatVisitTrip(): Trip {
  const romeOut = transport('Rome', 'Florence');
  const florenceOut = transport('Florence', 'Rome');
  return buildTrip({
    cities: [
      buildCity({
        name: 'Rome',
        dates: { arrival: '2026-06-15', departure: '2026-06-18' },
        transportIn: transport('Home', 'Rome', { mode: 'flight', price: 0 }),
        transportOut: romeOut,
      }),
      buildCity({
        name: 'Florence',
        dates: { arrival: '2026-06-18', departure: '2026-06-20' },
        transportIn: romeOut,
        transportOut: florenceOut,
      }),
      buildCity({
        name: 'Rome',
        dates: { arrival: '2026-06-20', departure: '2026-06-22' },
        transportIn: florenceOut,
        transportOut: transport('Rome', 'Home', { mode: 'flight', price: 0 }),
      }),
    ],
  });
}

async function refresh(refresh: LegRefresh) {
  mockedPlanChat.mockResolvedValueOnce({ type: 'leg_refresh', reply: 'Updated.', refresh });
  render(<AIChatPanel trip={useTripStore.getState().currentTrip!} />);
  const input = screen.getByPlaceholderText('Ask about your trip...');
  fireEvent.change(input, { target: { value: 'cheaper trains please' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(screen.getByText('Updated.')).toBeInTheDocument());
}

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: repeatVisitTrip(), restoredFromSession: false });
});

describe('a leg refresh on a trip that visits a city twice', () => {
  it('Florence → Rome lands on Florence and the SECOND Rome, leaving the first Rome alone', async () => {
    const before = useTripStore.getState().currentTrip!;
    await refresh({
      fromCity: 'Florence',
      toCity: 'Rome',
      date: '2026-06-20',
      options: [option(), option({ operator: 'Trenitalia', price: 35, departTime: '12:00', priceDelta: -5 })],
      totalFound: 2,
      updatedConstraints: null,
    });

    const [rome1, florence, rome2] = useTripStore.getState().currentTrip!.cities;
    expect(florence.transportOut).toMatchObject({ operator: 'Italo', price: 29, departTime: '10:15' });
    expect(florence.transportOut.alternatives).toHaveLength(1);
    expect(rome2.transportIn).toMatchObject({ operator: 'Italo', price: 29 });
    expect(rome2.transportIn.alternatives).toBeUndefined();
    // The opening Rome is a different visit: untouched.
    expect(rome1.transportIn).toEqual(before.cities[0].transportIn);
    expect(rome1.transportOut).toEqual(before.cities[0].transportOut);
  });

  it('Rome → Florence lands on the first Rome, the one that actually goes to Florence', async () => {
    const before = useTripStore.getState().currentTrip!;
    await refresh({
      fromCity: 'Rome',
      toCity: 'Florence',
      date: '2026-06-18',
      options: [option()],
      totalFound: 1,
      updatedConstraints: null,
    });

    const [rome1, florence, rome2] = useTripStore.getState().currentTrip!.cities;
    expect(rome1.transportOut).toMatchObject({ operator: 'Italo' });
    expect(florence.transportIn).toMatchObject({ operator: 'Italo' });
    expect(rome2.transportOut).toEqual(before.cities[2].transportOut);
  });

  it('a pair that is not a leg of the trip changes nothing', async () => {
    const before = useTripStore.getState().currentTrip!;
    await refresh({
      fromCity: 'Rome',
      toCity: 'Rome',
      date: '2026-06-18',
      options: [option()],
      totalFound: 1,
      updatedConstraints: null,
    });
    expect(useTripStore.getState().currentTrip!.cities).toEqual(before.cities);
  });

  it('keeps the current transport, notes and all, when the best option IS the current one', async () => {
    // The backend lists the leg's current transport first with priceDelta 0
    // (plan.ts transportToLegOption). Rebuilding it from that LegOption
    // dropped what a LegOption cannot carry, such as `noTrainData`.
    const trip = useTripStore.getState().currentTrip!;
    const current = { ...trip.cities[1].transportOut, mode: 'flight' as const, operator: 'ITA', departTime: '07:05', price: 88, noTrainData: true, baggage: '1 carry-on' };
    trip.cities[1] = { ...trip.cities[1], transportOut: current };
    trip.cities[2] = { ...trip.cities[2], transportIn: current };
    useTripStore.setState({ currentTrip: { ...trip } });

    await refresh({
      fromCity: 'Florence',
      toCity: 'Rome',
      date: '2026-06-20',
      options: [
        option({ mode: 'flight', operator: 'ITA', departTime: '07:05', price: 88, priceDelta: 0 }),
        option(),
      ],
      totalFound: 2,
      updatedConstraints: null,
    });

    const [, florence, rome2] = useTripStore.getState().currentTrip!.cities;
    expect(florence.transportOut).toMatchObject({ operator: 'ITA', noTrainData: true, baggage: '1 carry-on' });
    expect(florence.transportOut.alternatives).toHaveLength(1);
    expect(florence.transportOut.alternatives![0]).toMatchObject({ operator: 'Italo' });
    expect(rome2.transportIn).toMatchObject({ operator: 'ITA', noTrainData: true });
  });
});
