import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';

/**
 * "Adjust trip" after the results page was reloaded (audit M1).
 *
 * A reload empties memory: the store's answers and the guided transcript are
 * gone, and only this tab's sessionStorage copy is left. This file's modules
 * are fresh, which is exactly that state. Before the fix, /plan?resume=1 then
 * showed the blank "What kind of trip are you planning?" picker.
 */

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

afterEach(() => {
  window.history.pushState({}, '', '/');
  sessionStorage.clear();
});

const answers = {
  destinations: ['Paris'],
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  vibe: 'Culture',
  dateRange: { start: '2027-01-10', end: '2027-01-13' },
  nights: 3,
  travelers: 2,
  budget: 3000,
  budgetPerPerson: false,
  extraNotes: '',
};

it('restores the guided conversation from the tab', async () => {
  expect(useTripStore.getState().answers).toEqual({}); // nothing in memory
  sessionStorage.setItem(
    'bluemurr-planning-session',
    JSON.stringify({
      v: 1,
      answers,
      chatHistory: [],
      guided: {
        intent: 'place',
        steps: [{ id: 'destination', question: 'Where are you dreaming of going?', type: 'text' }],
        currentStepIndex: 0,
        messages: [
          { id: 'm1', role: 'assistant', content: 'What kind of trip are you planning?', stepId: 'intent' },
          { id: 'm2', role: 'user', content: 'I have a place in mind' },
          { id: 'm3', role: 'user', content: 'Paris', stepId: 'destination' },
        ],
        isComplete: true,
        vibe: 'Culture',
        msgCounter: 3,
      },
    }),
  );

  window.history.pushState({}, '', '/plan?resume=1');
  render(<PlanningChat />);

  expect(await screen.findByText('I have a place in mind')).toBeInTheDocument();
  expect(await screen.findByText('Find my trip')).toBeInTheDocument();
  expect(screen.queryByText('I know where I want to go')).toBeNull();
  expect(useTripStore.getState().answers.destinations).toEqual(['Paris']);
});

it('a fresh visit ignores and clears the stored session', async () => {
  sessionStorage.setItem(
    'bluemurr-planning-session',
    JSON.stringify({ v: 1, answers, chatHistory: [], guided: null }),
  );
  window.history.pushState({}, '', '/plan');
  render(<PlanningChat />);

  expect(await screen.findByText('I know where I want to go')).toBeInTheDocument();
  expect(sessionStorage.getItem('bluemurr-planning-session')).toBeNull();
  expect(useTripStore.getState().answers.destinations).toBeUndefined();
});
