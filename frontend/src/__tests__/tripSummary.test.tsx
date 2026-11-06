import './mocks';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import ConversationalPlanner from '@/components/planning/ConversationalPlanner';
import TripSummaryCard from '@/components/planning/TripSummaryCard';
import { summarizeAnswers, summaryText, shortDateRange, shortMoney, joinCities } from '@/lib/tripSummary';
import { useTripStore } from '@/store/tripStore';
import { converse, interpretPlan, reviseDestinations } from '@/lib/api';

/**
 * ROADMAP "Running trip summary on the conversation page": a card above the
 * /plan input bar that shows what has been answered so far, as one readable
 * line, updated per answer, with each fact clickable to revise it.
 */

const NOW = new Date('2026-11-05T12:00:00');
const line = (a: Parameters<typeof summarizeAnswers>[0]) => summaryText(summarizeAnswers(a, NOW));

describe('summarizeAnswers — natural-language line', () => {
  it('is empty before any answer (the card stays hidden)', () => {
    expect(summarizeAnswers({}, NOW)).toEqual([]);
    expect(summarizeAnswers({ planningMode: 'destination', destinations: [] }, NOW)).toEqual([]);
  });

  it('combines everything into one readable line, not a field list', () => {
    expect(
      line({
        vibe: 'Adventure',
        destinations: ['Venice', 'Rome'],
        origin: 'NYC',
        returnToHome: true,
        travelers: 2,
        budget: 3000,
        budgetPerPerson: false,
        dateRange: { start: '2027-06-15', end: '2027-06-22' },
        nights: 7,
      }),
    ).toBe('Adventure trip to Venice & Rome from NYC · Round-trip · 2 people · $3k total budget · Jun 15 – 22, 2027 · 7 nights');
  });

  it('phrases each field the way people say it', () => {
    expect(line({ travelers: 1 })).toBe('Solo');
    expect(line({ budget: 3000, budgetPerPerson: true })).toBe('$3k budget per person');
    expect(line({ budget: 2500 })).toBe('$2.5k budget');
    expect(line({ budget: 800, budgetPerPerson: false })).toBe('$800 total budget');
    expect(line({ returnToHome: false })).toBe('One-way');
    expect(line({ nights: 1 })).toBe('1 night');
    expect(line({ destinations: ['Rome'] })).toBe('Trip to Rome');
    expect(line({ origin: 'Boston' })).toBe('From Boston');
    expect(line({ vibe: 'culture and food vibes' })).toBe('Culture and food trip');
    expect(line({ destinations: ['Paris', 'Rome', 'Florence'], origin: 'Boston' })).toBe('Trip to Paris, Rome & Florence from Boston');
  });

  it('dates: same month, across months, this year without a year, vague phrases as typed', () => {
    expect(shortDateRange('2026-12-10', '2026-12-16', NOW)).toBe('Dec 10 – 16');
    expect(shortDateRange('2026-12-28', '2027-01-03', NOW)).toBe('Dec 28, 2026 – Jan 3, 2027');
    expect(shortDateRange('2027-03-30', '2027-04-04', NOW)).toBe('Mar 30 – Apr 4, 2027');
    expect(line({ dateRange: { start: 'Next month', end: 'Next month' }, flexible: true })).toBe('Next month');
    expect(line({ dateRange: { start: '2026-12-10', end: '2026-12-10' }, flexible: true })).toBe('Around Dec 10');
  });

  it('long notes and vibes are shortened; skipped answers do not appear', () => {
    const t = line({ extraNotes: 'no red-eye flights please and we would love a hotel with a pool near the center' });
    expect(t.startsWith('“no red-eye flights please and we would')).toBe(true);
    expect(t.endsWith('…”')).toBe(true);
    expect(line({ budget: 0, travelers: 0, origin: '  ' })).toBe('');
  });

  it('helpers', () => {
    expect(joinCities(['A'])).toBe('A');
    expect(joinCities(['A', 'B'])).toBe('A & B');
    expect(shortMoney(12000)).toBe('$12k');
    expect(shortMoney(1250)).toBe('$1.3k');
  });
});

describe('TripSummaryCard', () => {
  it('renders nothing until the first answer', () => {
    const { container } = render(<TripSummaryCard answers={{}} />);
    expect(container.querySelector('[data-testid=trip-summary]')).toBeNull();
  });

  it('shows the line and calls onEdit with the clicked fact; non-editable facts are plain text', () => {
    const onEdit = jest.fn();
    render(
      <TripSummaryCard
        answers={{ destinations: ['Rome'], travelers: 2, budget: 3000 }}
        onEdit={onEdit}
        editable={(f) => f !== 'budget'}
      />,
    );
    const card = screen.getByTestId('trip-summary');
    expect(card).toHaveAttribute('aria-label', 'Trip so far: Trip to Rome · 2 people · $3k budget');
    fireEvent.click(within(card).getByRole('button', { name: '2 people' }));
    expect(onEdit).toHaveBeenCalledWith('travelers');
    expect(within(card).queryByRole('button', { name: '$3k budget' })).toBeNull();
    expect(within(card).getByText('$3k budget')).toBeInTheDocument();
  });
});

// ── Guided planner (/plan) ───────────────────────────────────────────────

const mockedInterpret = interpretPlan as jest.MockedFunction<typeof interpretPlan>;
const mockedRevise = reviseDestinations as jest.MockedFunction<typeof reviseDestinations>;
const mockedConverse = converse as jest.MockedFunction<typeof converse>;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  window.history.pushState({}, '', '/plan');
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
  mockedInterpret.mockResolvedValue({ destinations: ['Caracas', 'Rome'] });
  mockedRevise.mockReset();
  mockedRevise.mockResolvedValue({ type: 'answer', reply: '', aboutDestinations: false });
});

const type = (bar: HTMLElement, value: string) => {
  fireEvent.change(bar, { target: { value } });
  fireEvent.keyDown(bar, { key: 'Enter' });
};
const summary = () => screen.queryByTestId('trip-summary');

describe('guided planner — running summary', () => {
  async function toTravelers() {
    render(<PlanningChat />);
    // Known up front so the first question after the destination is the party size.
    useTripStore.setState({
      answers: {
        origin: 'New York',
        originAirports: ['JFK'],
        returnToHome: true,
        vibe: 'Culture',
        dateRange: { start: '2027-01-10', end: '2027-01-14' },
        nights: 4,
        budget: 3000,
        budgetPerPerson: false,
      },
    });
    fireEvent.click(await screen.findByText('I know where I want to go'));
    const bar = await screen.findByPlaceholderText('Type a destination...');
    type(bar, 'Venezuela and Rome');
    await screen.findByText('How many people?', undefined, { timeout: 3000 });
    return screen.getByPlaceholderText('Or type how many people, e.g. "4"');
  }

  it('is hidden before the first answer and appears once there is one', async () => {
    render(<PlanningChat />);
    fireEvent.click(await screen.findByText('I know where I want to go'));
    await screen.findByPlaceholderText('Type a destination...');
    expect(summary()).toBeNull();
    act(() => useTripStore.getState().setAnswer('destinations', ['Lisbon']));
    expect(await screen.findByTestId('trip-summary')).toHaveAttribute('aria-label', 'Trip so far: Trip to Lisbon');
  });

  it('adds each answer as it comes in', async () => {
    const bar = await toTravelers();
    expect(summary()!.getAttribute('aria-label')).not.toMatch(/people/);
    type(bar, '2');
    await waitFor(() => expect(summary()!.getAttribute('aria-label')).toMatch(/· 2 people ·/));
    expect(summary()!.getAttribute('aria-label')).toMatch(/^Trip so far: Culture trip to Caracas & Rome from New York/);
  });

  it('clicking an answered fact opens that answer for editing, and the edit updates the summary', async () => {
    const bar = await toTravelers();
    type(bar, '2');
    const fact = await within(await screen.findByTestId('trip-summary')).findByRole('button', { name: '2 people' });
    fireEvent.click(fact);
    const editor = await screen.findByDisplayValue('2 people');
    fireEvent.change(editor, { target: { value: '4 people' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(useTripStore.getState().answers.travelers).toBe(4));
    expect(within(summary()!).getByRole('button', { name: '4 people' })).toBeInTheDocument();
  });

  it('facts with no answer bubble (picked up from the first sentence) are shown but not clickable', async () => {
    await toTravelers();
    const card = summary()!;
    expect(within(card).getByText('$3k total budget')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '$3k total budget' })).toBeNull();
  });

  it('clicking the cities starts a city change in the bar', async () => {
    const bar = await toTravelers();
    fireEvent.click(within(summary()!).getByRole('button', { name: 'Caracas & Rome' }));
    expect(bar).toHaveValue('Change my cities to ');
  });
});

describe('guided planner — editing an answer through the summary changes the stored answer', () => {
  // Origin, budget, dates and vibe edits used to change only the bubble.
  async function answered() {
    render(<PlanningChat />);
    fireEvent.click(await screen.findByText('I know where I want to go'));
    const bar = await screen.findByPlaceholderText('Type a destination...');
    mockedInterpret.mockResolvedValue({ destinations: ['Rome'] });
    type(bar, 'Rome');
    return bar;
  }

  it('budget: "$5,000 per person" → 5000, per person', async () => {
    await answered();
    // Drive straight to the budget answer through the store-backed handlers.
    await screen.findByText(/Where are you starting from\?/, undefined, { timeout: 3000 });
    const bar = screen.getByPlaceholderText(/starting from|New York/);
    type(bar, 'Boston');
    await screen.findByText(/One-way or round-trip\?/, undefined, { timeout: 3000 });
    type(screen.getByPlaceholderText('Or type "round-trip" or "one-way"'), 'round-trip');
    await screen.findByText(/vibe/i, undefined, { timeout: 3000 });
    type(screen.getByPlaceholderText('Or describe your vibe here...'), 'Food');
    await screen.findByText('When are you thinking?', undefined, { timeout: 3000 });
    type(screen.getByPlaceholderText('Or type when, e.g. "April 7-30, one week"'), 'March 3 to March 8 2027');
    // The nights question can still follow a typed range; answer it if it does.
    await waitFor(
      () => expect(screen.queryByText('How many people?') ?? screen.queryByText('How many nights total?')).not.toBeNull(),
      { timeout: 3000 },
    );
    if (!screen.queryByText('How many people?')) {
      type(screen.getByPlaceholderText('Or type a number, e.g. "7"'), '5');
    }
    await screen.findByText('How many people?', undefined, { timeout: 3000 });
    type(screen.getByPlaceholderText('Or type how many people, e.g. "4"'), '2');
    await screen.findByText("What's your budget looking like?", undefined, { timeout: 3000 });
    type(screen.getByPlaceholderText('Or type your budget, e.g. "$1500"'), '$3000 total');
    await waitFor(() => expect(useTripStore.getState().answers.budget).toBe(3000));

    const card = summary()!;
    expect(card.getAttribute('aria-label')).toBe(
      'Trip so far: Food trip to Rome from Boston · Round-trip · 2 people · $3k total budget · Mar 3 – 8, 2027 · 5 nights',
    );

    const edit = async (name: string, from: string, to: string) => {
      fireEvent.click(within(summary()!).getByRole('button', { name }));
      const editor = await screen.findByDisplayValue(from);
      fireEvent.change(editor, { target: { value: to } });
      fireEvent.keyDown(editor, { key: 'Enter' });
    };

    await edit('$3k total budget', '$3,000 total', '$5,000 per person');
    await waitFor(() => expect(useTripStore.getState().answers.budget).toBe(5000));
    expect(useTripStore.getState().answers.budgetPerPerson).toBe(true);

    await edit('Mar 3 – 8, 2027', 'Mar 3 – Mar 8, 2027', 'April 10 to April 17 2027');
    await waitFor(() => expect(useTripStore.getState().answers.dateRange).toEqual({ start: '2027-04-10', end: '2027-04-17' }));
    expect(useTripStore.getState().answers.nights).toBe(7);

    await edit('Food', 'Food', 'Nightlife');
    await waitFor(() => expect(useTripStore.getState().answers.vibe).toBe('Nightlife'));

    await edit('Boston', 'Boston', 'Chicago');
    await waitFor(() => expect(useTripStore.getState().answers.origin).toBe('Chicago'));

    expect(summary()!.getAttribute('aria-label')).toBe(
      'Trip so far: Nightlife trip to Rome from Chicago · Round-trip · 2 people · $5k budget per person · Apr 10 – 17, 2027 · 7 nights',
    );
  }, 40000);
});

// ── Free-chat planner ───────────────────────────────────────────────────

describe('conversational planner — running summary', () => {
  const props = {
    onFindTrip: jest.fn(),
    findTripLoading: false,
    findTripStatus: '',
    findTripError: null,
    onSwitchToGuided: jest.fn(),
  };

  it('appears after the first answer, updates per reply, and a click starts the revision in the input', async () => {
    mockedConverse.mockResolvedValueOnce({
      reply: 'Italy for two — where from?',
      updates: { destinations: ['Rome'], travelers: 2 },
      action: 'ask',
    });
    render(<ConversationalPlanner {...props} />);
    expect(summary()).toBeNull();
    const input = screen.getByPlaceholderText(/Say anything/);
    fireEvent.change(input, { target: { value: 'Rome, 2 of us' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText(/where from\?/);
    expect(summary()).toHaveAttribute('aria-label', 'Trip so far: Trip to Rome · 2 people');

    mockedConverse.mockResolvedValueOnce({ reply: 'Budget?', updates: { origin: 'Boston' }, action: 'ask' });
    fireEvent.change(input, { target: { value: 'from Boston' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('Budget?');
    expect(summary()).toHaveAttribute('aria-label', 'Trip so far: Trip to Rome from Boston · 2 people');

    fireEvent.click(within(summary()!).getByRole('button', { name: '2 people' }));
    expect(input).toHaveValue('Change the number of people to ');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
