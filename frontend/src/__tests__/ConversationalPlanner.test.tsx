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

    // Destinations + dates + travelers but STILL no origin → not ready yet
    // (origin is required — you can't search flights without a departure).
    mockedConverse.mockResolvedValue({
      reply: 'Where are you flying from?',
      updates: {
        destinations: ['Rome'],
        dates: { start: '2026-10-01', end: '2026-10-05' },
        travelers: 2,
      },
      action: 'ready', // even if the AI over-eagerly says ready, the client gate holds
    });
    await sendText('Rome, Oct 1-5, 2 people');
    await screen.findByText('Where are you flying from?');
    expect(screen.queryByText('Your trip so far')).not.toBeInTheDocument();

    // Now origin arrives → recap + Find my trip
    mockedConverse.mockResolvedValue({
      reply: "That's everything!",
      updates: { origin: 'New York' },
      action: 'ready',
    });
    await sendText('from New York');
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

  it('carries the full conversation history on every turn (regression)', async () => {
    mockedConverse.mockResolvedValue({ reply: 'Portugal is lovely!', updates: {}, action: 'ask' });
    render(<ConversationalPlanner {...baseProps} />);
    await sendText('thinking about portugal');
    await screen.findByText('Portugal is lovely!');

    mockedConverse.mockResolvedValue({ reply: 'Mild and a bit rainy.', updates: {}, action: 'ask' });
    await sendText('is it rainy there in november?');
    await screen.findByText('Mild and a bit rainy.');

    // The SECOND call must include the first exchange — an empty history
    // here made the AI lose the thread mid-conversation.
    const secondCall = mockedConverse.mock.calls[1][0];
    const contents = secondCall.history.map((h: any) => h.content);
    expect(contents).toContain('thinking about portugal');
    expect(contents).toContain('Portugal is lovely!');
  });

  describe('Use my location', () => {
    const setGeolocation = (impl: any) =>
      Object.defineProperty(global.navigator, 'geolocation', {
        value: impl,
        configurable: true,
      });

    afterEach(() => {
      // @ts-expect-error cleanup
      delete global.navigator.geolocation;
    });

    it('offers the location chip until an origin is known', () => {
      render(<ConversationalPlanner {...baseProps} />);
      expect(screen.getByText('Use my location')).toBeInTheDocument();
    });

    it('hides the chip once origin is set', () => {
      useTripStore.setState({ answers: { origin: 'Boston' } });
      render(<ConversationalPlanner {...baseProps} />);
      expect(screen.queryByText('Use my location')).not.toBeInTheDocument();
    });

    it('granted: sets origin + airports and announces through the conversation', async () => {
      setGeolocation({
        getCurrentPosition: (ok: any) =>
          ok({ coords: { latitude: 40.73, longitude: -73.99 } }),
      });
      mockedConverse.mockResolvedValue({
        reply: 'New York it is — where are you headed?',
        updates: { origin: 'New York' },
        action: 'ask',
      });

      render(<ConversationalPlanner {...baseProps} />);
      fireEvent.click(screen.getByText('Use my location'));

      await waitFor(() => {
        expect(mockedConverse).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "I'm starting from New York (detected from my location)",
          }),
        );
      });
      const a = useTripStore.getState().answers;
      expect(a.origin).toBe('New York');
      expect(a.originAirports).toContain('JFK');
      expect(await screen.findByText(/New York it is/)).toBeInTheDocument();
    });

    it('keeps the detected origin in known state on every later turn', async () => {
      // Regression: the AI asked "where are you flying from?" several turns
      // after the location chip already answered it.
      setGeolocation({
        getCurrentPosition: (ok: any) =>
          ok({ coords: { latitude: 39.95, longitude: -75.17 } }), // Philadelphia
      });
      mockedConverse.mockResolvedValue({ reply: 'Got it!', updates: {}, action: 'ask' });

      render(<ConversationalPlanner {...baseProps} />);
      fireEvent.click(screen.getByText('Use my location'));
      await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(1));

      await sendText('train friendly trip in Europe');
      await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(2));
      await sendText('give me some suggestions');
      await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(3));

      // EVERY call after the chip must carry the origin as known.
      for (const call of mockedConverse.mock.calls.slice(1)) {
        expect(call[0].known.origin).toBe('Philadelphia');
      }
      expect(useTripStore.getState().answers.origin).toBe('Philadelphia');
    });

    it('an empty-string origin update never erases a collected origin', async () => {
      // The model sometimes returns "" instead of null for fields the user
      // didn't mention this turn — that must not clobber the real origin.
      setGeolocation({
        getCurrentPosition: (ok: any) =>
          ok({ coords: { latitude: 39.95, longitude: -75.17 } }),
      });
      mockedConverse.mockResolvedValue({
        reply: 'Nice, Europe by train!',
        updates: { origin: '' } as any,
        action: 'ask',
      });

      render(<ConversationalPlanner {...baseProps} />);
      fireEvent.click(screen.getByText('Use my location'));
      await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(1));
      await sendText('train friendly trip in Europe');
      await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(2));

      expect(useTripStore.getState().answers.origin).toBe('Philadelphia');
    });

    it('denied: shows a friendly fallback and never calls the AI', async () => {
      setGeolocation({
        getCurrentPosition: (_ok: any, err: any) => err({ code: 1 }),
      });
      render(<ConversationalPlanner {...baseProps} />);
      fireEvent.click(screen.getByText('Use my location'));

      expect(
        await screen.findByText(/couldn't get your location/i),
      ).toBeInTheDocument();
      expect(mockedConverse).not.toHaveBeenCalled();
      // Flow not blocked — chip still available for retry, typing still works.
      expect(screen.getByText('Use my location')).toBeInTheDocument();
    });

    it('unsupported browser: explains and falls back to typing', async () => {
      render(<ConversationalPlanner {...baseProps} />);
      fireEvent.click(screen.getByText('Use my location'));
      expect(
        await screen.findByText(/doesn't support location sharing/i),
      ).toBeInTheDocument();
    });
  });
});
