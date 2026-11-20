import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConversationalPlanner from '@/components/planning/ConversationalPlanner';
import DateRangeCalendar from '@/components/planning/DateRangeCalendar';
import { converse } from '@/lib/api';
import { askingFrom } from '@/lib/planAsking';
import { useTripStore } from '@/store/tripStore';

/**
 * The chat planner offers a calendar when it asks about dates, and
 * "Use my location" only when it asks where they fly from (the owner's
 * report, 2026-11-20: no calendar under "When are you thinking of going?",
 * and the location chip under it instead).
 */

const mockedConverse = converse as jest.MockedFunction<typeof converse>;
const baseProps = { onFindTrip: jest.fn(), findTripLoading: false, findTripStatus: '', findTripError: null, onSwitchToGuided: jest.fn() };
const sendText = (text: string) => {
  const input = screen.getByPlaceholderText(/Say anything/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
};

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  mockedConverse.mockResolvedValue({ reply: 'Got it!', updates: {}, action: 'ask' });
});

describe('askingFrom', () => {
  it('takes the backend’s word when it gives one', () => {
    expect(askingFrom('Anything?', 'travelers')).toBe('travelers');
  });
  it('reads the last question: dates', () => {
    expect(askingFrom('London and Madrid — great combo! When are you thinking of going?')).toBe('dates');
    expect(askingFrom('Nice. What dates work for you?')).toBe('dates');
  });
  it('reads the last question: where they fly from', () => {
    expect(askingFrom('Love it. Where are you flying from?')).toBe('origin');
    expect(askingFrom('Are you flying from Paris, or starting the trip there after flying in from somewhere else?')).toBe('origin');
  });
  it('anything else, or no question: nothing', () => {
    expect(askingFrom('How many people are traveling?')).toBeNull();
    expect(askingFrom("That's everything I need.")).toBeNull();
  });
});

describe('the calendar in the chat', () => {
  const askDates = async (asking?: any) => {
    mockedConverse.mockResolvedValueOnce({
      reply: 'London and Madrid — great combo! When are you thinking of going?',
      updates: { destinations: ['London', 'Madrid'] },
      action: 'ask',
      ...(asking ? { asking } : {}),
    });
    render(<ConversationalPlanner {...baseProps} />);
    sendText('tryna go london and madrid');
    await screen.findByTestId('date-range-calendar');
  };

  it('shows under a dates question — from `asking` or from the question itself — and no location chip', async () => {
    await askDates('dates');
    expect(screen.queryByText('Use my location')).not.toBeInTheDocument();
  });

  it('works with a backend that does not say `asking` yet', async () => {
    await askDates();
    expect(screen.getByTestId('date-range-calendar')).toBeInTheDocument();
  });

  it('picking a first and last day stores them and answers in the chat', async () => {
    await askDates('dates');
    const days = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-day]')).filter((b) => !b.disabled);
    const [first, last] = [days[3], days[8]];
    fireEvent.click(first);
    expect(screen.getByTestId('date-range-summary')).toHaveTextContent('Now pick your last day');
    fireEvent.click(last);
    fireEvent.click(screen.getByRole('button', { name: 'Use these dates' }));
    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(2));
    expect(useTripStore.getState().answers.dateRange).toEqual({ start: first.dataset.day, end: last.dataset.day });
    expect(mockedConverse.mock.calls[1][0].known.dates).toEqual({ start: first.dataset.day, end: last.dataset.day });
    expect(screen.queryByTestId('date-range-calendar')).not.toBeInTheDocument();
  });

  it('"I\'m flexible" answers without dates', async () => {
    await askDates('dates');
    fireEvent.click(screen.getByRole('button', { name: "I'm flexible" }));
    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(2));
    expect(mockedConverse.mock.calls[1][0].message).toBe("I'm flexible on dates");
  });

  it('is not shown once dates are known', async () => {
    useTripStore.setState({ answers: { dateRange: { start: '2027-03-01', end: '2027-03-05' } } });
    mockedConverse.mockResolvedValueOnce({ reply: 'When are you thinking of going?', updates: {}, action: 'ask', asking: 'dates' });
    render(<ConversationalPlanner {...baseProps} />);
    sendText('hi');
    await screen.findByText(/When are you thinking/);
    expect(screen.queryByTestId('date-range-calendar')).not.toBeInTheDocument();
  });
});

describe('DateRangeCalendar', () => {
  it('past days cannot be picked; a last day before the first starts over', () => {
    const onSelect = jest.fn();
    render(<DateRangeCalendar onSelect={onSelect} onFlexible={jest.fn()} today="2026-11-20" />);
    expect((document.querySelector('[data-day="2026-11-19"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-day="2026-12-10"]')!);
    fireEvent.click(document.querySelector('[data-day="2026-12-05"]')!);
    expect(screen.getByTestId('date-range-summary')).toHaveTextContent('Now pick your last day');
    fireEvent.click(document.querySelector('[data-day="2026-12-09"]')!);
    expect(screen.getByTestId('date-range-summary')).toHaveTextContent('Dec 5 – Dec 9, 2026 · 4 nights');
    fireEvent.click(screen.getByRole('button', { name: 'Use these dates' }));
    expect(onSelect).toHaveBeenCalledWith('2026-12-05', '2026-12-09');
  });

  it('pages through months, not before this one', () => {
    render(<DateRangeCalendar onSelect={jest.fn()} onFlexible={jest.fn()} today="2026-11-20" />);
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByText('November 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('January 2027')).toBeInTheDocument();
    expect(screen.queryByText('November 2026')).not.toBeInTheDocument();
  });
});
