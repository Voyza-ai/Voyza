import './mocks';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { interpretPlan } from '@/lib/api';

/**
 * Guided planner ("I know where I want to go"): where they fly from and
 * round-trip vs one-way are ASKED after the city picker, never skipped on
 * the AI's guess. The guess skipped both questions without being stored, so
 * "we are flying from paris to london to germany" (production, 2026-11-17)
 * reached Find my trip with no home city asked, and a mid-route "back to
 * Paris" read as round-trip.
 */
const mockedInterpret = interpretPlan as jest.MockedFunction<typeof interpretPlan>;

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

const type = (bar: HTMLElement, value: string) => {
  fireEvent.change(bar, { target: { value } });
  fireEvent.keyDown(bar, { key: 'Enter' });
};

it('after the city picker it asks where they fly from, then round-trip — even when the AI guessed both', async () => {
  // What the interpret step returns for the owner's sentence (live, 2026-11-17).
  mockedInterpret.mockResolvedValue({
    destinations: ['London'],
    countries: [{ country: 'Germany', cities: ['Munich', 'Berlin', 'Hamburg'] }],
    needsCitySelection: true,
    origin: 'Paris',
    returnToHome: true,
  });
  render(<PlanningChat />);
  fireEvent.click(await screen.findByText('I know where I want to go'));
  type(await screen.findByPlaceholderText('Type a destination...'), 'we are flying from paris to london to germany');

  fireEvent.click(await screen.findByText('Continue with these cities', undefined, { timeout: 3000 }));

  await screen.findByText(/Where are you starting from\?/, undefined, { timeout: 3000 });
  expect(useTripStore.getState().answers.origin).toBeUndefined();

  type(screen.getByPlaceholderText(/starting from|New York/), 'New York');
  await screen.findByText(/One-way or round-trip\?/, undefined, { timeout: 3000 });
  expect(useTripStore.getState().answers.returnToHome).toBeUndefined();
});
