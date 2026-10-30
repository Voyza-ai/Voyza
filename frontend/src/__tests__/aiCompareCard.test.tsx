/**
 * The flight-vs-train card offers only real switches.
 *
 * D-07 (UI side): the card offered "Switch to flight" on a leg that was
 * already a flight (live sweep, Paris → Zurich, r1-chat-3.png; harness
 * 2026-10-30, Interlaken → Geneva and Geneva → Lucerne). A switch is offered
 * only to a mode that is not the leg's current one and that has an option;
 * a price the provider did not give reads as unknown, not $0.
 */
import './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useTripStore } from '@/store/tripStore';
import { planChat, planChatSuggestions, ModeComparison } from '@/lib/api';
import type { Trip } from '@/lib/types';
import { buildTrip, mockTransportFlight } from './fixtures';

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const mockedSuggestions = planChatSuggestions as jest.MockedFunction<typeof planChatSuggestions>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedSuggestions.mockResolvedValue({ suggestions: ['Why this order of cities?'] });
  useTripStore.setState({ priceMode: 'total' });
});

const flightOpt = { mode: 'flight' as const, operator: 'Swiss', price: 278, currency: 'USD', duration: '1h 13m', durationMinutes: 73, stops: 0 };
const trainOpt = { mode: 'train' as const, operator: 'SBB', price: 190, currency: 'USD', duration: '4h 2m', durationMinutes: 242 };

function comparison(over: Partial<ModeComparison> = {}): ModeComparison {
  return {
    fromCity: 'Rome',
    toCity: 'Florence',
    date: '2026-06-18',
    flight: flightOpt,
    train: trainOpt,
    cheapest: 'train',
    fastest: 'flight',
    recommendation: 'train',
    priceDifference: 88,
    timeDifference: 169,
    ...over,
  };
}

async function askCompare(trip: Trip, cmp: ModeComparison) {
  useTripStore.setState({ currentTrip: trip });
  mockedPlanChat.mockResolvedValueOnce({ type: 'mode_comparison', reply: 'Compared.', comparison: cmp });
  render(<AIChatPanel trip={trip} />);
  const input = screen.getByPlaceholderText('Ask about your trip...');
  fireEvent.change(input, { target: { value: 'compare flight and train from Rome to Florence' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(screen.getByText('Compared.')).toBeInTheDocument());
}

/** A Rome → Florence leg that is a flight (the fixture's is a train). */
function flightLegTrip(): Trip {
  const trip = buildTrip();
  return {
    ...trip,
    cities: trip.cities.map((c, i) =>
      i === 0 ? { ...c, transportOut: { ...mockTransportFlight, from: 'Rome', to: 'Florence' } } : c,
    ),
  };
}

describe('flight-vs-train card', () => {
  it('never offers the mode the leg already uses', async () => {
    // Fixture leg Rome → Florence is a TRAIN.
    await askCompare(buildTrip(), comparison());
    expect(screen.getByRole('button', { name: 'Switch to flight' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to train' })).toBeNull();
  });

  it('a flight leg with no train found offers no switch at all', async () => {
    await askCompare(flightLegTrip(), comparison({ train: null, cheapest: 'flight', fastest: 'unavailable', recommendation: 'flight' }));
    // Before: "Switch to flight" on a leg that is already a flight.
    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
    expect(screen.getByText('No options found')).toBeInTheDocument();
  });

  it('a train with no price reads as unknown, not $0', async () => {
    await askCompare(flightLegTrip(), comparison({ train: { ...trainOpt, price: 0 } }));
    const cell = screen.getByText('Train').closest('div.px-3') as HTMLElement;
    expect(cell.textContent).not.toMatch(/\$0(?!\d)/);
    expect(within(cell).getByRole('button', { name: 'Switch to train' })).toBeInTheDocument();
  });
});
