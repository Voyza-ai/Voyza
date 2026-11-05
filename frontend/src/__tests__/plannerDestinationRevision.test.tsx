import './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlanningChat, { looksLikeDestinationEdit } from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { interpretPlan, reviseDestinations } from '@/lib/api';

/**
 * Guided planner: correcting a destination after it was submitted.
 *
 * ROADMAP bug: "no way to correct a destination typo once submitted
 * (Venezuela when user meant Venice)". Anything typed after the destination
 * step went to the question on screen. Now a message that looks like a
 * destination edit goes to /api/plan/revise-destinations first, and only the
 * destination list changes — dates, budget and vibe stay as they were.
 */

const mockedInterpret = interpretPlan as jest.MockedFunction<typeof interpretPlan>;
const mockedRevise = reviseDestinations as jest.MockedFunction<typeof reviseDestinations>;

// Everything but the destination and the party size is already known, so
// the first question after the destination is "How many people?".
const known = {
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  vibe: 'Culture',
  dateRange: { start: '2027-01-10', end: '2027-01-14' },
  nights: 4,
  budget: 3000,
  budgetPerPerson: false,
};

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
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

async function atTravelersStep() {
  render(<PlanningChat />);
  useTripStore.setState({ answers: { ...known } });
  fireEvent.click(await screen.findByText('I know where I want to go'));
  const bar = await screen.findByPlaceholderText('Type a destination...');
  fireEvent.change(bar, { target: { value: 'Venezuela and Rome' } });
  fireEvent.keyDown(bar, { key: 'Enter' });
  await screen.findByText('How many people?', undefined, { timeout: 3000 });
  expect(useTripStore.getState().answers.destinations).toEqual(['Caracas', 'Rome']);
  return screen.getByPlaceholderText('Or type how many people, e.g. "4"');
}

const type = (bar: HTMLElement, value: string) => {
  fireEvent.change(bar, { target: { value } });
  fireEvent.keyDown(bar, { key: 'Enter' });
};

describe('guided planner — destination correction', () => {
  it('"actually Venice not Venezuela" fixes the destination and keeps dates, budget and vibe', async () => {
    mockedRevise.mockResolvedValueOnce({
      type: 'revision',
      reply: "Got it — Venice instead of Caracas. You're going to Venice and Rome.",
      destinations: ['Venice', 'Rome'],
      changes: [{ kind: 'replace', from: 'Caracas', to: 'Venice' }],
    });
    const bar = await atTravelersStep();
    type(bar, 'actually Venice not Venezuela');

    await screen.findByText("Got it — Venice instead of Caracas. You're going to Venice and Rome.");
    const a = useTripStore.getState().answers;
    expect(a.destinations).toEqual(['Venice', 'Rome']);
    expect(a.dateRange).toEqual(known.dateRange);
    expect(a.budget).toBe(3000);
    expect(a.vibe).toBe('Culture');
    expect(a.nights).toBe(4);
    // Not read as the party size.
    expect(a.travelers).toBeUndefined();
    expect(mockedRevise).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'actually Venice not Venezuela',
        destinations: ['Caracas', 'Rome'],
        currentQuestion: 'How many people?',
      }),
    );

    // Still on the same question, and it still takes its answer.
    type(screen.getByPlaceholderText('Or type how many people, e.g. "4"'), '2');
    await waitFor(() => expect(useTripStore.getState().answers.travelers).toBe(2));
    expect(mockedRevise).toHaveBeenCalledTimes(1);
  });

  it('a message the AI says is not about destinations goes to the question on screen', async () => {
    mockedRevise.mockResolvedValueOnce({ type: 'answer', reply: '', aboutDestinations: false });
    const bar = await atTravelersStep();
    type(bar, 'I meant 3 of us');
    await waitFor(() => expect(useTripStore.getState().answers.travelers).toBe(3));
    expect(useTripStore.getState().answers.destinations).toEqual(['Caracas', 'Rome']);
    // One bubble for the message, not two.
    expect(screen.getAllByText('3 people')).toHaveLength(1);
    expect(screen.queryByText('I meant 3 of us')).not.toBeInTheDocument();
  });

  it('an ambiguous request gets the clarifying question and changes nothing', async () => {
    mockedRevise.mockResolvedValueOnce({
      type: 'answer',
      reply: 'Which one should I swap — Caracas or Rome?',
      aboutDestinations: true,
    });
    const bar = await atTravelersStep();
    type(bar, 'swap one of the cities');
    await screen.findByText('Which one should I swap — Caracas or Rome?');
    expect(useTripStore.getState().answers.destinations).toEqual(['Caracas', 'Rome']);
    expect(useTripStore.getState().answers.travelers).toBeUndefined();
  });

  it('a plain answer never calls the revision endpoint', async () => {
    const bar = await atTravelersStep();
    type(bar, '4');
    await waitFor(() => expect(useTripStore.getState().answers.travelers).toBe(4));
    expect(mockedRevise).not.toHaveBeenCalled();
  });

  it('the bar stays after "Perfect" so a city can still be corrected', async () => {
    mockedRevise.mockResolvedValueOnce({
      type: 'revision',
      reply: "Got it — Venice instead of Caracas. You're going to Venice and Rome.",
      destinations: ['Venice', 'Rome'],
      changes: [{ kind: 'replace', from: 'Caracas', to: 'Venice' }],
    });
    const bar = await atTravelersStep();
    type(bar, '2');
    // The last question ("Anything else?") is skippable.
    fireEvent.click(await screen.findByText('Skip this', undefined, { timeout: 3000 }));
    await screen.findByText("Perfect — I've got everything I need. Ready to find your trip?", undefined, { timeout: 3000 });
    const recapBar = screen.getByPlaceholderText('Need to change a city? e.g. "Venice instead of Rome"');
    type(recapBar, 'Venice not Venezuela');
    await screen.findByText("Got it — Venice instead of Caracas. You're going to Venice and Rome.");
    expect(useTripStore.getState().answers.destinations).toEqual(['Venice', 'Rome']);
    expect(useTripStore.getState().answers.travelers).toBe(2);
    expect(screen.getByText('Find my trip')).toBeInTheDocument();
  });

  it('a failed revision call falls through to the question on screen', async () => {
    mockedRevise.mockRejectedValueOnce(new Error('503'));
    const bar = await atTravelersStep();
    type(bar, 'add 2 more of us');
    await waitFor(() => expect(useTripStore.getState().answers.travelers).toBe(2));
    expect(useTripStore.getState().answers.destinations).toEqual(['Caracas', 'Rome']);
  });
});

describe('looksLikeDestinationEdit', () => {
  it.each([
    ['actually Venice not Venezuela', true],
    ['drop Rome', true],
    ['add Florence too', true],
    ['Rome for longer?', true],
    ['4', false],
    ['$2,000', false],
    ['round-trip', false],
    ['June 3-10', false],
    ['no long layovers please', false],
  ])('%s → %s', (text, expected) => {
    expect(looksLikeDestinationEdit(text, ['Caracas', 'Rome'])).toBe(expected);
  });

  it('is false before there are destinations', () => {
    expect(looksLikeDestinationEdit('actually Venice', [])).toBe(false);
  });
});
