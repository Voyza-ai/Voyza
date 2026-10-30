import './mocks';
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';
import { fetchHomeLegs } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import ResultsPage from '@/app/results/page';
import type { Trip } from '@/lib/types';

/**
 * Choosing the other reading of an ambiguous origin re-prices the home legs.
 * While that search runs, the header must not price the trip WITHOUT them
 * (audit D-09).
 *
 * chooseOrigin clears both legs so the flowchart shows its searching pill.
 * The header priced the same cleared trip, so for the ~4 s the search took
 * the total fell by both flights and the savings pill read the gap as money
 * saved — on the demo trip $1,991 became $1,063 with "You can save $320",
 * then $1,645 once the Maine fares landed.
 */

const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;

const leg = (from: string, to: string, price: number) =>
  ({ originAirport: from, destAirport: to, price, currency: 'USD', durationMinutes: 677, stops: 0 }) as any;

const OREGON_OUT = leg('PDX', 'FCO', 604);
const OREGON_BACK = leg('FLR', 'PDX', 599);
const MAINE_OUT = leg('PWM', 'FCO', 700);
const MAINE_BACK = leg('FLR', 'PWM', 650);

function portlandTrip(): Trip {
  const trip = buildTrip({
    savings: 0,
    returnToHome: true,
    origin: {
      city: 'Portland',
      airports: ['PDX', 'SLE'],
      returnAirports: ['PDX', 'SLE'],
      outboundLeg: OREGON_OUT,
      returnLeg: OREGON_BACK,
    },
    originClarification: {
      input: 'Portland',
      reason: 'near-tie',
      candidates: [
        { placeId: 'gn:5746545', label: 'Portland, Oregon, United States', airports: ['PDX', 'SLE'] },
        { placeId: 'gn:4975802', label: 'Portland, Maine, United States', airports: ['PWM', 'PSM'], distanceKm: 4_020 },
      ],
    },
  } as any);
  // As the planner leaves it: nothing to save at today's prices.
  return { ...trip, totalCost: liveTripTotal(trip) };
}

/** The header's "$N /person" line. Not animated, so it reads true at once. */
const perPersonLine = () => screen.getByText(/\/person/).textContent;
const perPerson = (trip: Trip) => `$${Math.round(liveTripTotal(trip) / trip.travelers).toLocaleString()} /person`;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function chooseMaine() {
  fireEvent.click(screen.getByRole('button', { name: /see the other$/i }));
  await act(async () => {
    fireEvent.click(screen.getByText('Portland, Maine, United States'));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

describe('the header while home legs are re-priced for another origin', () => {
  it('keeps the last real total and claims no saving until the new fares land', async () => {
    const trip = portlandTrip();
    useTripStore.setState({ currentTrip: trip });
    const out = deferred<any>();
    const back = deferred<any>();
    mockedFetchHomeLegs.mockImplementation((p: any) => (p.outbound ? out.promise : back.promise));

    render(<ResultsPage />);
    expect(perPersonLine()).toBe(perPerson(trip));
    expect(screen.queryByText('Best price')).not.toBeInTheDocument();

    await chooseMaine();
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalledTimes(2));

    // Mid-search: the store and the flowchart have no legs...
    const cleared = useTripStore.getState().currentTrip!;
    expect(cleared.origin?.outboundLeg).toBeNull();
    expect(cleared.origin?.returnLeg).toBeNull();
    expect(screen.getAllByText(/Finding flights/i).length).toBeGreaterThan(0);
    // ...but the header still prices a whole trip, and invents no saving.
    expect(perPersonLine()).toBe(perPerson(trip));
    expect(screen.queryByText('Best price')).not.toBeInTheDocument();
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();

    // One direction lands: the header still holds the last settled total. It
    // moves once, when every search has landed — a total half Maine, half
    // Oregon is not a price anyone can book.
    await act(async () => {
      out.resolve({ outboundLeg: MAINE_OUT });
    });
    expect(perPersonLine()).toBe(perPerson(trip));
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();

    await act(async () => {
      back.resolve({ returnLeg: MAINE_BACK });
    });
    const settled = useTripStore.getState().currentTrip!;
    expect(settled.origin?.returnLeg).toEqual(MAINE_BACK);
    await waitFor(() => expect(perPersonLine()).toBe(perPerson(settled)));
  });

  it('a "Best price" checked against the other reading\'s home flights is dropped', async () => {
    const trip = { ...portlandTrip(), dateShiftChecked: true };
    useTripStore.setState({ currentTrip: trip });
    mockedFetchHomeLegs.mockResolvedValue({ outboundLeg: MAINE_OUT, returnLeg: MAINE_BACK });
    render(<ResultsPage />);
    expect(screen.getByText('Best price')).toBeInTheDocument();
    await chooseMaine();
    expect(useTripStore.getState().currentTrip!.dateShiftChecked).toBe(false);
    expect(screen.queryByText('Best price')).not.toBeInTheDocument();
  });

  it('cheaper fares from the chosen reading are a new price, not a saving', async () => {
    // Harness, Portland → "Portland, Maine" with Maine fares cheaper than
    // Oregon's: the header settled on "YOU CAN SAVE $1,950 vs default
    // routing" — the stored total still described the Oregon trip, and the
    // saving is stored total − live total.
    const trip = portlandTrip();
    useTripStore.setState({ currentTrip: trip });
    const out = deferred<any>();
    const back = deferred<any>();
    mockedFetchHomeLegs.mockImplementation((p: any) => (p.outbound ? out.promise : back.promise));

    render(<ResultsPage />);
    await chooseMaine();
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalledTimes(2));
    await act(async () => {
      out.resolve({ outboundLeg: { ...MAINE_OUT, price: 300 } });
      back.resolve({ returnLeg: { ...MAINE_BACK, price: 280 } });
    });

    const settled = useTripStore.getState().currentTrip!;
    await waitFor(() => expect(perPersonLine()).toBe(perPerson(settled)));
    expect(liveTripTotal(settled)).toBeLessThan(liveTripTotal(trip));
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();
    expect(screen.queryByText('Best price')).not.toBeInTheDocument();
    // The stored total follows the live one, so the baseline moved with it.
    expect(settled.totalCost).toBe(liveTripTotal(settled));
  });

  it('when the new search fails, the header shows the trip as it really is', async () => {
    const trip = portlandTrip();
    useTripStore.setState({ currentTrip: trip });
    mockedFetchHomeLegs.mockRejectedValue(new Error('429'));

    render(<ResultsPage />);
    await chooseMaine();
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalledTimes(2));

    const legless = useTripStore.getState().currentTrip!;
    expect(legless.origin?.outboundLeg).toBeNull();
    await waitFor(() => expect(perPersonLine()).toBe(perPerson(legless)));
  });

  it('a first load with no legs is untouched: there is nothing to stand in for them', async () => {
    const trip = portlandTrip();
    trip.origin = { ...trip.origin!, outboundLeg: null, returnLeg: null };
    useTripStore.setState({ currentTrip: trip });
    mockedFetchHomeLegs.mockReturnValue(new Promise(() => {}));

    render(<ResultsPage />);
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalled());
    expect(perPersonLine()).toBe(perPerson(trip));
  });
});
