/**
 * The AI's opening line is true, in the unit the price toggle shows.
 *
 * A11: it said "save you $X vs the most common routing". The optimizer's
 * baseline is the order the cities were given (optimizer.ts, savingsVsNaive),
 * and $X was always the group total: on the same screen, with Per person on,
 * the savings pill read $18 and the AI $109. Harness 2026-10-30 (NYC → Paris,
 * London, Zurich, 6 travellers): pill $148 / $25, AI "$148" in both modes.
 */
import './mocks';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useTripStore } from '@/store/tripStore';
import { planChat, planChatSuggestions } from '@/lib/api';
import { buildTrip } from './fixtures';

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const mockedSuggestions = planChatSuggestions as jest.MockedFunction<typeof planChatSuggestions>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedSuggestions.mockResolvedValue({ suggestions: ['Why this order of cities?'] });
  useTripStore.setState({ priceMode: 'total' });
});

describe('opening line', () => {
  it('names the real baseline: the order the cities were given', () => {
    render(<AIChatPanel trip={buildTrip({ savings: 249 })} />);
    expect(screen.queryByText(/most common routing/)).toBeNull();
    expect(
      screen.getByText(/I built this 2-city trip to save you \$249 vs your original city order\./),
    ).toBeInTheDocument();
  });

  it('follows the Total / Per person toggle, both ways', () => {
    const trip = buildTrip({ savings: 249, travelers: 2 });
    useTripStore.setState({ currentTrip: trip });
    render(<AIChatPanel trip={trip} />);
    act(() => useTripStore.getState().setPriceMode('perPerson'));
    expect(screen.getByText(/save you \$125 per person vs your original city order/)).toBeInTheDocument();
    act(() => useTripStore.getState().setPriceMode('total'));
    expect(screen.getByText(/save you \$249 vs your original city order/)).toBeInTheDocument();
  });

  it('the date-shift tip follows the toggle too', () => {
    const trip = buildTrip({
      savings: 0,
      travelers: 2,
      dateShiftSuggestion: { newStartDate: '2026-08-28', dayOffset: 2, savings: 3230 },
    } as any);
    useTripStore.setState({ currentTrip: trip });
    render(<AIChatPanel trip={trip} />);
    expect(screen.getByText(/would save about \$3,230\./)).toBeInTheDocument();
    act(() => useTripStore.getState().setPriceMode('perPerson'));
    expect(screen.getByText(/would save about \$1,615 per person\./)).toBeInTheDocument();
  });

  it('tells the AI what the traveller sees', async () => {
    const trip = buildTrip({ savings: 249, travelers: 2 });
    useTripStore.setState({ currentTrip: trip, priceMode: 'perPerson' });
    mockedPlanChat.mockResolvedValue({ type: 'answer', reply: 'OK' });
    render(<AIChatPanel trip={trip} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mockedPlanChat).toHaveBeenCalled());
    expect(mockedPlanChat.mock.calls[0][0].history?.[0].content).toMatch(/\$125 per person vs your original city order/);
  });
});
