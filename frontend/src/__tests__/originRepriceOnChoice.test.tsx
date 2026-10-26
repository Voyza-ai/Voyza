import './mocks';
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';
import { fetchHomeLegs } from '@/lib/api';
import ResultsPage from '@/app/results/page';

/**
 * Picking a different reading of an ambiguous origin has to RE-PRICE the home
 * legs, not just relabel the home card.
 *
 * The trap this exists for: the backfill effect that prices home legs is keyed
 * on `[trip.id, trip.origin.city]`, and for an ambiguous origin the city STRING
 * is identical across readings by definition — Portland, Oregon and Portland,
 * Maine are both "Portland". So the obvious implementation (clear the legs,
 * reset the once-per-trip guard, write the new airports) changes nothing the
 * effect watches, the effect never re-runs, and the flights stay priced from
 * the wrong coast while the card claims otherwise. Silent, and worse than not
 * offering the choice at all.
 */

const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;

function portlandTrip() {
  return buildTrip({
    origin: {
      city: 'Portland',
      airports: ['PDX', 'SLE'],
      returnAirports: ['PDX', 'SLE'],
      outboundLeg: null,
      returnLeg: null,
    },
    originClarification: {
      input: 'Portland',
      reason: 'near-tie',
      candidates: [
        {
          placeId: 'gn:5746545',
          label: 'Portland, Oregon, United States',
          airports: ['PDX', 'SLE'],
        },
        {
          placeId: 'gn:4975802',
          label: 'Portland, Maine, United States',
          airports: ['PWM', 'PSM'],
          distanceKm: 4_020,
        },
      ],
    },
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFetchHomeLegs.mockResolvedValue([] as any);
  useTripStore.setState({ currentTrip: null, priceMode: 'total' });
});

describe('choosing another reading of an ambiguous origin', () => {
  it('re-prices the home legs from the chosen airports', async () => {
    useTripStore.setState({ currentTrip: portlandTrip() });
    render(<ResultsPage />);

    // The first pass prices from the reading we guessed.
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalled());
    const firstAirports = mockedFetchHomeLegs.mock.calls.map(
      (c: any[]) => c[0].originAirports,
    );
    expect(firstAirports).toContainEqual(['PDX', 'SLE']);
    mockedFetchHomeLegs.mockClear();

    // The traveller says they meant Maine.
    fireEvent.click(screen.getByRole('button', { name: /see the other$/i }));
    await act(async () => {
      fireEvent.click(screen.getByText('Portland, Maine, United States'));
    });

    // THE ASSERTION THAT MATTERS: a new search went out for Maine's airports.
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalled());
    const after = mockedFetchHomeLegs.mock.calls.map((c: any[]) => c[0].originAirports);
    expect(after).toContainEqual(['PWM', 'PSM']);
    // ...and nothing still pricing from Oregon.
    expect(after).not.toContainEqual(['PDX', 'SLE']);
  });

  it('stops asking once the traveller has answered', async () => {
    useTripStore.setState({ currentTrip: portlandTrip() });
    render(<ResultsPage />);

    fireEvent.click(screen.getByRole('button', { name: /see the other$/i }));
    await act(async () => {
      fireEvent.click(screen.getByText('Portland, Maine, United States'));
    });

    expect(useTripStore.getState().currentTrip?.originClarification).toBeUndefined();
    expect(screen.queryByText(/You typed/)).not.toBeInTheDocument();
  });

  it('relabels the home city to the chosen reading', async () => {
    // "Portland, Maine, United States" → "Portland". Same string here, but the
    // Washington/Washington DC and Melbourne cases differ, and the home card
    // reads this field.
    useTripStore.setState({ currentTrip: portlandTrip() });
    render(<ResultsPage />);

    fireEvent.click(screen.getByRole('button', { name: /see the other$/i }));
    await act(async () => {
      fireEvent.click(screen.getByText('Portland, Maine, United States'));
    });

    const origin = useTripStore.getState().currentTrip?.origin;
    expect(origin?.city).toBe('Portland');
    expect(origin?.airports).toEqual(['PWM', 'PSM']);
    expect(origin?.returnAirports).toEqual(['PWM', 'PSM']);
  });
});
