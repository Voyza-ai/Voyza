import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import ConversationalPlanner from '@/components/planning/ConversationalPlanner';
import ResultsHeader from '@/components/results/ResultsHeader';
import { summarizeAnswers, summaryText } from '@/lib/tripSummary';
import { splitVibeText, vibeList, vibePhrase, joinVibes } from '@/lib/vibes';
import { vibesFromAnswer } from '@/lib/vibeMap';
import { useTripStore } from '@/store/tripStore';
import {
  converse,
  optimizeTrip,
  searchActivities,
  searchHotels,
  searchRestaurants,
  suggestDestinationsForVibe,
} from '@/lib/api';
import { buildTrip } from './fixtures';

/**
 * Several vibes per trip: the vibe step on /plan takes one to three pills
 * (plus typed text) and a Continue, instead of moving on at the first click.
 * The backend keeps getting ONE vibe string — the picks joined, "Culture,
 * Architecture" — and the "Trip so far" line reads "Culture & architecture".
 */

const NOW = new Date('2026-11-05T12:00:00');
const line = (a: Parameters<typeof summarizeAnswers>[0]) => summaryText(summarizeAnswers(a, NOW));

const mockedVibe = suggestDestinationsForVibe as jest.MockedFunction<typeof suggestDestinationsForVibe>;
const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedActivities = searchActivities as jest.MockedFunction<typeof searchActivities>;
const mockedRestaurants = searchRestaurants as jest.MockedFunction<typeof searchRestaurants>;
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
});

afterEach(() => window.history.pushState({}, '', '/'));

const pill = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
const pressed = (el: HTMLElement) => el.getAttribute('aria-pressed') === 'true';
const summary = () => screen.getByTestId('trip-summary').getAttribute('aria-label');

/** "I'm chasing a vibe" up to its first question, the vibe pills. */
async function toVibeStep(known: Record<string, unknown> = {}) {
  render(<PlanningChat />);
  // The fresh visit resets the store on mount; what's already known goes in after.
  if (Object.keys(known).length) useTripStore.setState({ answers: { ...known } });
  fireEvent.click(await screen.findByText("I'm chasing a vibe"));
  await screen.findByText('What vibe are you chasing?', undefined, { timeout: 3000 });
  return screen.findByRole('button', { name: /^Culture/ });
}

describe('vibe step — multi-select', () => {
  it('a click toggles a pill on and off, and does not move on by itself', async () => {
    await toVibeStep();
    fireEvent.click(pill('Culture'));
    expect(pressed(pill('Culture'))).toBe(true);
    fireEvent.click(pill('Architecture'));
    expect(pressed(pill('Architecture'))).toBe(true);
    fireEvent.click(pill('Culture'));
    expect(pressed(pill('Culture'))).toBe(false);
    expect(pressed(pill('Architecture'))).toBe(true);

    // Still on the vibe question: nothing confirmed yet.
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.queryByText('Where are you starting from?')).toBeNull();
    expect(useTripStore.getState().answers.vibe).toBeUndefined();
  });

  it('caps at three: a fourth pill does nothing and the hint says why', async () => {
    await toVibeStep();
    expect(screen.getByTestId('vibe-hint')).toHaveTextContent('Pick up to 3');
    fireEvent.click(pill('Beachy'));
    fireEvent.click(pill('Skiing'));
    fireEvent.click(pill('Adventure'));
    fireEvent.click(pill('Culture'));

    expect(pressed(pill('Culture'))).toBe(false);
    expect(pill('Culture')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(3);
    expect(screen.getByTestId('vibe-hint')).toHaveTextContent("That's 3 — unpick one to swap");

    // Unpicking one frees a slot again.
    fireEvent.click(pill('Skiing'));
    fireEvent.click(pill('Culture'));
    expect(pressed(pill('Culture'))).toBe(true);
  });

  it('Continue confirms the picks: one string for the backend, the list for the planner', async () => {
    await toVibeStep();
    const cont = screen.getByRole('button', { name: /^Continue/ });
    expect(cont).toBeDisabled();
    fireEvent.click(pill('Culture'));
    fireEvent.click(pill('Architecture'));
    fireEvent.click(cont);

    const a = useTripStore.getState().answers;
    expect(a.vibe).toBe('Culture, Architecture');
    expect(a.vibes).toEqual(['Culture', 'Architecture']);
    expect(screen.getByText('Culture & Architecture', { selector: 'div' })).toBeInTheDocument();
    await screen.findByText('Where are you starting from?', undefined, { timeout: 3000 });
    expect(screen.queryByTestId('vibe-pills')).toBeNull();
  });

  it('Enter confirms the picks too', async () => {
    await toVibeStep();
    fireEvent.click(pill('Culture'));
    fireEvent.click(pill('Beachy'));
    // From the chat bar (empty)…
    fireEvent.keyDown(screen.getByPlaceholderText('Or describe your vibe here...'), { key: 'Enter' });
    expect(useTripStore.getState().answers.vibes).toEqual(['Culture', 'Beachy']);
    await screen.findByText('Where are you starting from?', undefined, { timeout: 3000 });
  });

  it('Enter on a focused pill confirms rather than toggling it again', async () => {
    await toVibeStep();
    fireEvent.click(pill('Adventure'));
    pill('Adventure').focus();
    fireEvent.keyDown(pill('Adventure'), { key: 'Enter' });
    expect(useTripStore.getState().answers.vibes).toEqual(['Adventure']);
  });

  it('typed text combines with the pills ("Culture" + "food")', async () => {
    await toVibeStep();
    fireEvent.click(pill('Culture'));
    const bar = screen.getByPlaceholderText('Or describe your vibe here...');
    fireEvent.change(bar, { target: { value: 'food' } });
    fireEvent.keyDown(bar, { key: 'Enter' });

    const a = useTripStore.getState().answers;
    expect(a.vibes).toEqual(['Culture', 'food']);
    expect(a.vibe).toBe('Culture, food');
    expect(summary()).toBe('Trip so far: Culture & food trip');
  });

  it('typed text alone still answers the step, as before', async () => {
    await toVibeStep();
    const bar = screen.getByPlaceholderText('Or describe your vibe here...');
    fireEvent.change(bar, { target: { value: 'somewhere warm with good food' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(useTripStore.getState().answers.vibe).toBe('somewhere warm with good food');
    expect(useTripStore.getState().answers.vibes).toEqual(['somewhere warm with good food']);
  });
});

describe('"Trip so far" with several vibes', () => {
  it('reads naturally', () => {
    expect(line({ vibes: ['Culture', 'Food'], destinations: ['Paris', 'London'] })).toBe(
      'Culture & food trip to Paris & London',
    );
    expect(line({ vibes: ['Culture', 'Food', 'Architecture'], destinations: ['Paris'] })).toBe(
      'Culture, food & architecture trip to Paris',
    );
    // Free text keeps its own casing after the first vibe.
    expect(line({ vibes: ['Culture', 'Paris nightlife'] })).toBe('Culture & Paris nightlife trip');
  });

  it('a joined string with no list (a saved or staged trip) reads the same', () => {
    expect(line({ vibe: 'Culture, Food', destinations: ['Paris', 'London'] })).toBe(
      'Culture & food trip to Paris & London',
    );
  });
});

describe('editing the vibe answer', () => {
  it('re-opens the pills with the current picks, and the edit replaces them', async () => {
    await toVibeStep();
    fireEvent.click(pill('Culture'));
    fireEvent.click(pill('Architecture'));
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    await screen.findByText('Where are you starting from?', undefined, { timeout: 3000 });

    // The summary fact opens the vibe answer's editor.
    fireEvent.click(within(screen.getByTestId('trip-summary')).getByRole('button', { name: 'Culture & architecture' }));
    const editor = await screen.findByTestId('vibe-editor');
    const inEditor = (label: string) => within(editor).getByRole('button', { name: new RegExp(`^${label}`) });
    expect(pressed(inEditor('Culture'))).toBe(true);
    expect(pressed(inEditor('Architecture'))).toBe(true);
    expect(pressed(inEditor('Beachy'))).toBe(false);

    fireEvent.click(inEditor('Architecture'));
    fireEvent.click(inEditor('Adventure'));
    fireEvent.change(within(editor).getByLabelText('Describe your vibe'), { target: { value: 'food' } });
    fireEvent.click(within(editor).getByRole('button', { name: /Save/ }));

    const a = useTripStore.getState().answers;
    expect(a.vibes).toEqual(['Culture', 'Adventure', 'food']);
    expect(a.vibe).toBe('Culture, Adventure, food');
    expect(screen.queryByTestId('vibe-editor')).toBeNull();
    expect(screen.getByText('Culture, Adventure & food', { selector: 'div' })).toBeInTheDocument();
    expect(summary()).toMatch(/^Trip so far: Culture, adventure & food trip/);
  });

  it('the pencil on the bubble opens the same editor', async () => {
    await toVibeStep();
    fireEvent.click(pill('Beachy'));
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    await screen.findByText('Where are you starting from?', undefined, { timeout: 3000 });

    const bubble = screen.getByText('Beachy', { selector: 'div' });
    fireEvent.click(within(bubble.parentElement!).getByTitle('Edit message'));
    const editor = await screen.findByTestId('vibe-editor');
    expect(pressed(within(editor).getByRole('button', { name: /^Beachy/ }))).toBe(true);
  });
});

describe('what the backend gets for two vibes', () => {
  it('"I\'m chasing a vibe": suggestions, picks and the trip all carry "Culture, Architecture"', async () => {
    mockedVibe.mockResolvedValue({
      suggestions: [
        { destination_city: 'Paris', destination_country: 'France', why_it_fits_vibe: 'Museums and Haussmann.' } as any,
      ],
      reasoning_summary: '',
      tier_up_suggestion: null,
    } as any);
    mockedOptimize.mockResolvedValue({
      routes: [],
      bestRoute: { ordering: ['Paris'], totalCost: 0, legs: [] },
      savingsVsNaive: 0,
      iataCodes: {},
      dates: { Paris: { arrival: '2027-01-12', departure: '2027-01-17' } },
    } as any);
    mockedHotels.mockResolvedValue([]);

    await toVibeStep({
      origin: 'New York',
      originAirports: ['JFK'],
      returnToHome: true,
      dateRange: { start: '2027-01-12', end: '2027-01-17' },
      nights: 5,
      travelers: 2,
      budget: 6000,
      budgetPerPerson: false,
    });
    fireEvent.click(pill('Culture'));
    fireEvent.click(pill('Architecture'));
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    await screen.findByText('Anything else I should know?', undefined, { timeout: 3000 });
    fireEvent.click(await screen.findByText('Skip this', undefined, { timeout: 3000 }));
    fireEvent.click(await screen.findByText('Find my trip', undefined, { timeout: 3000 }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
    expect(mockedVibe).toHaveBeenCalledTimes(1);
    expect(mockedVibe.mock.calls[0][0]).toMatchObject({ vibe: 'Culture, Architecture', origin: 'New York' });
    await waitFor(() => expect(mockedActivities).toHaveBeenCalled());
    expect(mockedActivities.mock.calls[0][0]).toMatchObject({ city: 'Paris', vibe: 'Culture, Architecture' });
    expect(mockedRestaurants.mock.calls[0][0]).toMatchObject({ city: 'Paris', vibe: 'Culture, Architecture' });
    // Saved trips keep it in `trips.vibe` (saveTrip sends trip.vibe).
    expect(useTripStore.getState().currentTrip!.vibe).toBe('Culture, Architecture');
  }, 20_000);
});

describe('"tell me everything at once"', () => {
  const props = {
    onFindTrip: jest.fn(),
    findTripLoading: false,
    findTripStatus: '',
    findTripError: null,
    onSwitchToGuided: jest.fn(),
  };

  it('"a beach and food trip" becomes two vibes; other wording stays as said', async () => {
    mockedConverse.mockResolvedValueOnce({
      reply: 'Beach and food — love it. Where to?',
      updates: { vibe: 'a beach and food trip' },
      action: 'ask',
    });
    render(<ConversationalPlanner {...props} />);
    const input = screen.getByPlaceholderText(/Say anything/);
    fireEvent.change(input, { target: { value: 'a beach and food trip' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText(/love it/);
    expect(useTripStore.getState().answers.vibes).toEqual(['beach', 'food']);
    expect(useTripStore.getState().answers.vibe).toBe('beach, food');
    expect(summary()).toBe('Trip so far: Beach & food trip');

    expect(splitVibeText('somewhere warm with good food')).toEqual(['somewhere warm with good food']);
    expect(splitVibeText('rock and roll')).toEqual(['rock and roll']);
  });

  it("the AI's vibe picker takes several pills and Continue", async () => {
    mockedConverse.mockResolvedValueOnce({ reply: 'What vibe?', updates: {}, action: 'show_vibe_picker' });
    render(<ConversationalPlanner {...props} />);
    const input = screen.getByPlaceholderText(/Say anything/);
    fireEvent.change(input, { target: { value: 'Paris and London' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByRole('button', { name: /^Culture/ });

    mockedConverse.mockResolvedValueOnce({ reply: 'Got it.', updates: {}, action: 'ask' });
    fireEvent.click(pill('Culture'));
    fireEvent.click(pill('Architecture'));
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    await screen.findByText('Got it.');
    expect(mockedConverse.mock.calls[1][0].message).toBe('Culture & Architecture vibes');
    expect(useTripStore.getState().answers.vibes).toEqual(['Culture', 'Architecture']);
  });
});

describe('an old saved trip with a single vibe', () => {
  beforeAll(() => {
    let id = 0;
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++id);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  it('reads as a list of one', () => {
    expect(vibeList({ vibe: 'Culture' })).toEqual(['Culture']);
    expect(vibeList({ vibe: null })).toEqual([]);
    expect(vibePhrase(vibeList({ vibe: 'Culture' }))).toBe('Culture');
    expect(line({ vibe: 'Culture', destinations: ['Rome'] })).toBe('Culture trip to Rome');
  });

  it('carries its vibe into a "cheaper dates" replan, which reads it back', () => {
    // As GET /api/trips/:id returns it: trips.vibe is one plain string.
    const trip = buildTrip({
      vibe: 'Culture',
      dateShiftSuggestion: {
        dayOffset: -2,
        newStartDate: '2026-06-13',
        newTotalCost: 1456,
        savings: 255,
        options: [{ dayOffset: -2, newStartDate: '2026-06-13', newTotalCost: 1456, savings: 255 }],
      },
    } as any);
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByText(/You can save/i));
    fireEvent.click(screen.getByText('2 days earlier'));

    const staged = JSON.parse(sessionStorage.getItem('bluemurr-autorun')!);
    expect(staged.vibe).toBe('Culture');
    expect(staged.vibes).toEqual(['Culture']);
    expect(line(staged)).toMatch(/^Culture trip to Rome & Florence/);
  });

  it('a trip saved with two vibes comes back as two', () => {
    const trip = buildTrip({
      vibe: 'Culture, Food',
      dateShiftSuggestion: {
        dayOffset: 1,
        newStartDate: '2026-06-16',
        newTotalCost: 1456,
        savings: 255,
        options: [{ dayOffset: 1, newStartDate: '2026-06-16', newTotalCost: 1456, savings: 255 }],
      },
    } as any);
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByText(/You can save/i));
    fireEvent.click(screen.getByText('1 day later'));
    const staged = JSON.parse(sessionStorage.getItem('bluemurr-autorun')!);
    expect(staged.vibes).toEqual(['Culture', 'Food']);
    expect(line(staged)).toMatch(/^Culture & food trip to Rome & Florence/);
  });
});

describe('city chips for several vibes', () => {
  it('each picked vibe gets a chip before any gets a second', () => {
    expect(vibesFromAnswer(['Culture', 'Food'])).toEqual(['history', 'food']);
    expect(vibesFromAnswer('Culture, Food')).toEqual(['history', 'food']);
    expect(vibesFromAnswer('culture')).toEqual(['history', 'art']);
    expect(joinVibes(['Culture', 'culture', ' Food '])).toBe('Culture, Food');
  });
});
