import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { planChat, planChatSuggestions } from '@/lib/api';

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const mockedPlanChatSuggestions =
  planChatSuggestions as jest.MockedFunction<typeof planChatSuggestions>;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip() });
  mockedPlanChatSuggestions.mockResolvedValue({
    suggestions: [
      'Why this order of cities?',
      'Make Barcelona cheaper',
      'Pin Rome to specific dates',
      'Add a day in Lisbon',
    ],
  });
});

describe('AIChatPanel', () => {
  it('shows initial greeting message with trip info', () => {
    const trip = buildTrip({ savings: 249 });
    render(<AIChatPanel trip={trip} />);
    expect(screen.getByText(/2-city trip/)).toBeInTheDocument();
    expect(screen.getByText(/\$249/)).toBeInTheDocument();
  });

  it('renders trip-aware fallback suggestions before the AI call lands', () => {
    // Fallback chips (computed locally from trip shape) should appear
    // immediately, before the async chat-suggestions call resolves.
    render(<AIChatPanel trip={buildTrip()} />);
    expect(screen.getByText('Why this order of cities?')).toBeInTheDocument();
  });

  it('replaces fallback suggestions with backend-tailored ones on mount', async () => {
    mockedPlanChatSuggestions.mockResolvedValueOnce({
      suggestions: ['Fancy prompt A', 'Fancy prompt B', 'Fancy prompt C', 'Fancy prompt D'],
    });
    render(<AIChatPanel trip={buildTrip()} />);
    await waitFor(() => {
      expect(screen.getByText('Fancy prompt A')).toBeInTheDocument();
    });
  });

  it('sends message with history to planChat on submit', async () => {
    mockedPlanChat.mockResolvedValue({ type: 'answer', reply: 'Here is my response' });

    render(<AIChatPanel trip={buildTrip()} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Make it cheaper' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(mockedPlanChat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Make it cheaper',
          currentTrip: expect.any(Object),
          history: expect.any(Array),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Here is my response')).toBeInTheDocument();
    });
  });

  it('includes prior turns in history for multi-turn context', async () => {
    mockedPlanChat
      .mockResolvedValueOnce({ type: 'answer', reply: 'First reply' })
      .mockResolvedValueOnce({ type: 'answer', reply: 'Second reply' });

    render(<AIChatPanel trip={buildTrip()} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');

    // Turn 1
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText('First reply')).toBeInTheDocument());

    // Turn 2 — history should include the greeting + First + First reply
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      const lastCall = mockedPlanChat.mock.calls[mockedPlanChat.mock.calls.length - 1][0];
      expect(lastCall.history?.length).toBeGreaterThan(0);
      expect(lastCall.history?.some((h: any) => h.content === 'First')).toBe(true);
      expect(lastCall.history?.some((h: any) => h.content === 'First reply')).toBe(true);
    });
  });

  it('renders a proposal card when the AI returns type=proposal', async () => {
    mockedPlanChat.mockResolvedValue({
      type: 'proposal',
      reply: 'Pinning Rome March 5-10',
      proposal: {
        kind: 'date_shift',
        toolName: 'pin_city_dates',
        toolInput: { city: 'Rome', arrival: '2026-03-05', departure: '2026-03-10' },
        diff: [
          {
            city: 'Rome',
            oldArrival: '2026-06-01',
            newArrival: '2026-03-05',
            oldDeparture: '2026-06-04',
            newDeparture: '2026-03-10',
          },
        ],
        proposedConstraints: {},
        proposedTrip: buildTrip({ totalCost: 800 }),
      },
    });

    render(<AIChatPanel trip={buildTrip()} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Pin Rome March 5-10' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Proposed date change')).toBeInTheDocument();
    });
    expect(screen.getByText('Rome')).toBeInTheDocument();
    expect(screen.getByText('Accept')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('Accept swaps the trip in Zustand and hides the buttons', async () => {
    const proposedTrip = buildTrip({ totalCost: 777, savings: 42 });
    mockedPlanChat.mockResolvedValue({
      type: 'proposal',
      reply: 'Proposal',
      proposal: {
        kind: 'date_shift',
        toolName: 'pin_city_dates',
        toolInput: { city: 'Rome', arrival: '2026-03-05', departure: '2026-03-10' },
        diff: [{ city: 'Rome', oldArrival: null, newArrival: '2026-03-05', oldDeparture: null, newDeparture: '2026-03-10' }],
        proposedConstraints: {},
        proposedTrip,
      },
    });

    render(<AIChatPanel trip={buildTrip()} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'pin it' } });
    fireEvent.submit(input.closest('form')!);

    const acceptBtn = await screen.findByText('Accept');
    fireEvent.click(acceptBtn);

    // Zustand should have the proposed trip now.
    expect(useTripStore.getState().currentTrip?.totalCost).toBe(777);
    // Confirmation stub replaces the buttons.
    await waitFor(() =>
      expect(screen.getByText(/Applied to your trip/)).toBeInTheDocument(),
    );
  });

  it('applies leg_refresh directly to the trip without rendering a card', async () => {
    // New behavior: transport queries return type=leg_refresh. Frontend
    // immediately updates the trip's transport{Out,In}.alternatives and
    // posts a summary bubble. No inline card, no Accept/Reject — the user
    // clicks on the flowchart Connector card to pick a different option.
    mockedPlanChat.mockResolvedValue({
      type: 'leg_refresh',
      reply: 'Found 12, showing the top 4 for Rome → Florence.',
      refresh: {
        fromCity: 'Rome',
        toCity: 'Florence',
        date: '2026-06-04',
        totalFound: 12,
        updatedConstraints: {},
        options: [
          { mode: 'train', operator: 'Trenitalia', price: 23, currency: 'USD', departTime: '05:10', arriveTime: '06:46', duration: '1h 36m', durationMinutes: 96, priceDelta: -162 },
          { mode: 'train', operator: 'Italo', price: 42, currency: 'USD', departTime: '09:00', arriveTime: '10:30', duration: '1h 30m', durationMinutes: 90, priceDelta: -143 },
          { mode: 'flight', operator: 'AF1203', price: 185, currency: 'USD', departTime: '18:00', arriveTime: '19:20', duration: '1h 20m', durationMinutes: 80, priceDelta: 0 },
          { mode: 'flight', operator: 'AZ567', price: 210, currency: 'USD', departTime: '20:00', arriveTime: '21:25', duration: '1h 25m', durationMinutes: 85, priceDelta: 25 },
        ],
      },
    });

    const tripWithRomeFlo = buildTrip({
      cities: [
        { name: 'Rome', country: 'IT', transportIn: { mode: 'flight', operator: 'start', duration: '', price: 0 }, transportOut: { mode: 'flight', operator: 'current', duration: '1h', price: 185 } } as any,
        { name: 'Florence', country: 'IT', transportIn: { mode: 'flight', operator: 'current', duration: '1h', price: 185 }, transportOut: { mode: 'flight', operator: 'end', duration: '', price: 0 } } as any,
      ] as any,
    });
    useTripStore.setState({ currentTrip: tripWithRomeFlo });

    render(<AIChatPanel trip={tripWithRomeFlo} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Show me cheaper options Rome to Florence' } });
    fireEvent.submit(input.closest('form')!);

    // Chat bubble shows the summary.
    await waitFor(() => {
      expect(screen.getByText(/Found 12, showing the top 4/i)).toBeInTheDocument();
    });

    // Zustand trip was mutated: transportOut of Rome has 3 alternatives
    // (the cheapest option became main, the other 3 became alternatives).
    const after = useTripStore.getState().currentTrip;
    expect(after?.cities[0].transportOut.operator).toBe('Trenitalia');
    expect(after?.cities[0].transportOut.alternatives?.length).toBe(3);
    // Florence's transportIn mirrors the new main.
    expect(after?.cities[1].transportIn.operator).toBe('Trenitalia');

    // No inline card rendered.
    expect(screen.queryByText(/Accept/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reject/)).not.toBeInTheDocument();
  });

  it('Reject leaves the trip untouched and shows dismissed state', async () => {
    const originalTrip = buildTrip({ totalCost: 1234 });
    useTripStore.setState({ currentTrip: originalTrip });
    mockedPlanChat.mockResolvedValue({
      type: 'proposal',
      reply: 'Proposal',
      proposal: {
        kind: 'date_shift',
        toolName: 'pin_city_dates',
        toolInput: { city: 'Rome', arrival: '2026-03-05', departure: '2026-03-10' },
        diff: [{ city: 'Rome', oldArrival: null, newArrival: '2026-03-05', oldDeparture: null, newDeparture: '2026-03-10' }],
        proposedConstraints: {},
        proposedTrip: buildTrip({ totalCost: 999 }),
      },
    });

    render(<AIChatPanel trip={originalTrip} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'pin it' } });
    fireEvent.submit(input.closest('form')!);

    const rejectBtn = await screen.findByText('Reject');
    fireEvent.click(rejectBtn);

    // Zustand unchanged.
    expect(useTripStore.getState().currentTrip?.totalCost).toBe(1234);
    await waitFor(() => expect(screen.getByText(/Dismissed/)).toBeInTheDocument());
  });

  it('shows an error fallback when planChat rejects', async () => {
    mockedPlanChat.mockRejectedValue(new Error('network'));

    render(<AIChatPanel trip={buildTrip()} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument();
    });
  });

  it('disables send button when input is empty', () => {
    render(<AIChatPanel trip={buildTrip()} />);
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });

  it('clears input after sending', async () => {
    mockedPlanChat.mockResolvedValue({ type: 'answer', reply: 'OK' });
    render(<AIChatPanel trip={buildTrip()} />);
    const input = screen.getByPlaceholderText('Ask about your trip...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Test message' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(input.value).toBe(''));
  });
});
