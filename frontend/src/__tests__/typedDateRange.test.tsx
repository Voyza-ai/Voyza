import './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { parseDateRangeInput } from '@/lib/parseDate';
import { optimizeTrip } from '@/lib/api';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;

/**
 * A date range typed into the planner keeps its end date.
 *
 * The bottom bar's dates step ran the text through `parseDateInput`, which
 * returns ONE date, and stored `{ start, end: start }` marked flexible. So
 * "Jan 10 to Jan 17, 2027" became a trip starting Jan 10 with no end, the
 * planner asked "How many nights total?" for a length the traveller had
 * already given, and the year was lost too ("Jan 10 to Jan 17, 2028" also
 * started 2027-01-10, the next Jan 10 after today).
 */

describe('parseDateRangeInput', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 9, 30, 12)); // 30 Oct 2026
  });
  afterAll(() => jest.useRealTimers());

  it.each([
    ['Jan 10 to Jan 17, 2027', '2027-01-10', '2027-01-17'],
    ['Jan 10 to Jan 17, 2028', '2028-01-10', '2028-01-17'],
    ['January 10 - January 17 2027', '2027-01-10', '2027-01-17'],
    ['Jan 10, 2027 to Jan 17, 2027', '2027-01-10', '2027-01-17'],
    ['jan 10th through jan 17th, 2027', '2027-01-10', '2027-01-17'],
    ['Jan 10-17, 2027', '2027-01-10', '2027-01-17'],
    ['Jan 10 – 17', '2027-01-10', '2027-01-17'], // en dash; next Jan 10 is 2027
    ['from June 3 to June 12', '2027-06-03', '2027-06-12'],
    ['Dec 28 to Jan 4, 2027', '2026-12-28', '2027-01-04'], // year belongs to the end
    ['Dec 28 to Jan 4', '2026-12-28', '2027-01-04'],
    ['10 Jan to 17 Jan 2027', '2027-01-10', '2027-01-17'],
    ['10-17 January 2027', '2027-01-10', '2027-01-17'],
    ['2027-01-10 to 2027-01-17', '2027-01-10', '2027-01-17'],
    ['April 7-30', '2027-04-07', '2027-04-30'],
  ])('%s → %s .. %s', (input, start, end) => {
    expect(parseDateRangeInput(input)).toEqual({ start, end });
  });

  it.each([
    'Jan 10',
    'next month',
    'June 2027',
    'April 7-30, one week', // a window plus a length is not a range
    'Jan 17 to Jan 10, 2027', // backwards
    'Mar 10 to Feb 5, 2027', // would be 11 months across New Year: a typo
    'Jan 10 to Jun 10, 2027', // 151 nights, past the planner's 90-night clamp
    'Jan 10 to Jan 10, 2027', // zero nights
    'Feb 30 to Mar 3, 2027', // no such day
    'Paris in June',
    '',
  ])('not a range: %s', (input) => {
    expect(parseDateRangeInput(input)).toBeNull();
  });
});

describe('the guided planner, dates typed into the bar', () => {
  beforeAll(() => {
    Element.prototype.scrollTo = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    // Everything before the dates step already answered, so the flow goes
    // destination → dates.
    useTripStore.setState({
      answers: { origin: 'New York', originAirports: ['JFK'], returnToHome: true, vibe: 'Culture' },
      chatHistory: [],
      currentTrip: null,
    });
  });

  afterEach(() => window.history.pushState({}, '', '/'));

  async function reachDatesStep() {
    window.history.pushState({}, '', '/plan?resume=1');
    render(<PlanningChat />);
    fireEvent.click(await screen.findByText('I know where I want to go'));
    const bar = await screen.findByPlaceholderText('Type a destination...');
    fireEvent.change(bar, { target: { value: 'Paris' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await screen.findByText('When are you thinking?', undefined, { timeout: 3000 });
    return screen.getByPlaceholderText(/Or type when/);
  }

  it('keeps both ends of a typed range, all the way to the optimizer', async () => {
    const bar = await reachDatesStep();
    fireEvent.change(bar, { target: { value: 'Jan 10 to Jan 17, 2027' } });
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() =>
      expect(useTripStore.getState().answers.dateRange).toEqual({ start: '2027-01-10', end: '2027-01-17' }),
    );
    const a = useTripStore.getState().answers;
    expect(a.flexible).toBe(false);
    expect(a.nights).toBe(7);
    // The echo names both ends, in words (D-19; was "2027-01-10").
    expect(screen.getByText('Jan 10 – Jan 17, 2027')).toBeInTheDocument();

    // The flow still asks for nights (a separate, pre-existing issue:
    // `advanceToNextStep` reads `answers` from the render closure, so it
    // cannot see what this same handler just stored). Skipping it must keep
    // the typed length rather than lose it.
    await screen.findByText('How many nights total?', undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Skip$/ }));
    await screen.findByText('How many people?', undefined, { timeout: 3000 });
    fireEvent.change(bar, { target: { value: '6' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await screen.findByText("What's your budget looking like?", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Skip$/ }));
    await screen.findByText('Anything else I should know?', undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Skip this/ }));
    fireEvent.click(await screen.findByText('Find my trip', undefined, { timeout: 3000 }));

    await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));
    const call = mockedOptimize.mock.calls[0][0];
    expect(call.startDate).toBe('2027-01-10');
    expect(call.totalNights).toBe(7);
  }, 20_000);

  it('a single typed date behaves as before: flexible start, nights asked', async () => {
    const bar = await reachDatesStep();
    fireEvent.change(bar, { target: { value: '2027-01-10' } });
    fireEvent.keyDown(bar, { key: 'Enter' });

    await screen.findByText('How many nights total?', undefined, { timeout: 3000 });
    expect(useTripStore.getState().answers.dateRange).toEqual({ start: '2027-01-10', end: '2027-01-10' });
    expect(useTripStore.getState().answers.flexible).toBe(true);
  });
});
