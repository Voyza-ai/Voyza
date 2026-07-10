import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConversationalPlanner from '@/components/planning/ConversationalPlanner';
import { converse } from '@/lib/api';
import { useTripStore } from '@/store/tripStore';

const mockedConverse = converse as jest.MockedFunction<typeof converse>;

const baseProps = {
  onFindTrip: jest.fn(),
  findTripLoading: false,
  findTripStatus: '',
  findTripError: null,
  onSwitchToGuided: jest.fn(),
};

const sendText = async (text: string) => {
  const input = screen.getByPlaceholderText(/Say anything/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
};

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  mockedConverse.mockResolvedValue({ reply: 'Sounds great!', updates: {}, action: 'ask' });
});

describe('ConversationalPlanner', () => {
  it('greets, sends a message, applies extracted updates to the store', async () => {
    mockedConverse.mockResolvedValue({
      reply: 'Italy in October for two — where from?',
      updates: {
        dates: { start: '2026-10-01', end: '2026-10-15' },
        travelers: 2,
      },
      action: 'ask',
      quickReplies: ['New York', 'Boston'],
    });

    render(<ConversationalPlanner {...baseProps} />);
    expect(screen.getByText(/Tell me about the trip/)).toBeInTheDocument();

    await sendText('2 of us, Italy, October');
    expect(await screen.findByText(/where from\?/)).toBeInTheDocument();

    const a = useTripStore.getState().answers;
    expect(a.travelers).toBe(2);
    expect(a.dateRange).toEqual({ start: '2026-10-01', end: '2026-10-15' });
    // Quick replies render as tappable chips
    expect(screen.getByText('New York')).toBeInTheDocument();

    // The call carried history + known state
    expect(mockedConverse).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '2 of us, Italy, October',
        known: expect.objectContaining({ travelers: null }),
      }),
    );
  });

  it('summons the city picker when the AI provides countries', async () => {
    mockedConverse.mockResolvedValue({
      reply: 'Which Italian cities?',
      updates: { countries: [{ country: 'Italy', cities: ['Rome', 'Florence', 'Venice'] }] },
      action: 'show_city_picker',
    });
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('Italy please');

    expect(await screen.findByText('Rome')).toBeInTheDocument();
    // Picking cities feeds back through the conversation
    fireEvent.click(screen.getByText('Rome'));
    fireEvent.click(screen.getByText('Venice'));
    mockedConverse.mockResolvedValue({ reply: 'Great picks!', updates: { destinations: ['Rome', 'Venice'] }, action: 'ask' });
    fireEvent.click(screen.getByText('Add these cities'));
    await waitFor(() => {
      expect(mockedConverse).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "Let's do Rome, Venice" }),
      );
    });
  });

  it('summons the budget slider and submits through the conversation', async () => {
    mockedConverse.mockResolvedValue({
      reply: "What's the budget looking like?",
      updates: {},
      action: 'show_budget_slider',
    });
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('Rome next month');

    // Slider widget appears (min/max labels)
    expect(await screen.findByText('$100 min')).toBeInTheDocument();
    expect(screen.getByText('$10,000+ max')).toBeInTheDocument();

    mockedConverse.mockResolvedValue({ reply: 'Noted!', updates: { budget: 2500 }, action: 'ask' });
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '2500' } });
    fireEvent.click(screen.getByText('Set budget'));
    await waitFor(() => {
      expect(mockedConverse).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: 'Budget is $2,500 per person' }),
      );
    });
  });

  it('shows the recap card on ready — but only when minimums are actually met', async () => {
    // AI says ready but nothing is known → recap must NOT show
    mockedConverse.mockResolvedValue({ reply: 'All set!', updates: {}, action: 'ready' });
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('hello');
    await screen.findByText('All set!');
    expect(screen.queryByText('Your trip so far')).not.toBeInTheDocument();

    // Now with real minimums delivered in updates → recap + Find my trip
    mockedConverse.mockResolvedValue({
      reply: "That's everything!",
      updates: {
        destinations: ['Rome'],
        dates: { start: '2026-10-01', end: '2026-10-05' },
        travelers: 2,
      },
      action: 'ready',
    });
    await sendText('Rome, Oct 1-5, 2 people');
    expect(await screen.findByText('Your trip so far')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Find my trip →'));
    expect(baseProps.onFindTrip).toHaveBeenCalled();
  });

  it('marks a failed send with an honest error and retries the SAME message', async () => {
    mockedConverse.mockRejectedValueOnce(new Error('503 assistant_unavailable'));
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('Rome in June');

    expect(await screen.findByText('The assistant is unavailable right now')).toBeInTheDocument();

    mockedConverse.mockResolvedValueOnce({ reply: 'Rome in June — nice!', updates: {}, action: 'ask' });
    fireEvent.click(screen.getByText('Retry'));

    expect(await screen.findByText('Rome in June — nice!')).toBeInTheDocument();
    // Retry re-sent the same text without duplicating the user bubble
    const bubbles = screen.getAllByText('Rome in June');
    expect(bubbles).toHaveLength(1);
  });

  it('offers the guided fallback after repeated failures', async () => {
    mockedConverse.mockRejectedValue(new Error('down'));
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('one');
    await screen.findAllByText(/unavailable|reach the server/);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(3));

    const fallback = await screen.findByText(/continue with guided questions/i);
    fireEvent.click(fallback);
    expect(baseProps.onSwitchToGuided).toHaveBeenCalled();
  });

  it('persists successful turns into the store for resume', async () => {
    mockedConverse.mockResolvedValue({ reply: 'Got it!', updates: {}, action: 'ask' });
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('Barcelona');
    await screen.findByText('Got it!');

    const history = useTripStore.getState().chatHistory;
    // Greeting + the exchanged turns all persist (the greeting is part of
    // the conversation a resumed session should show).
    expect(history).toHaveLength(3);
    expect(history[1]).toEqual({ role: 'user', content: 'Barcelona' });
    expect(history[2]).toEqual({ role: 'assistant', content: 'Got it!' });
  });
});
