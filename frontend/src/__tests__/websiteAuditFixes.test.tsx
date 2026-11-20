import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { optimizeTrip, suggestDestinationsForVibe } from '@/lib/api';
import { missingPriceParts } from '@/components/results/MissingPricesNotice';

/**
 * Fixes from the bluemurr.com functional audit (docs/WEBSITE_AUDIT.md).
 */

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;
const mockedVibe = suggestDestinationsForVibe as jest.MockedFunction<typeof suggestDestinationsForVibe>;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
});

afterEach(() => window.history.pushState({}, '', '/'));

const optimizeFor = (city: string) =>
  ({
    routes: [],
    bestRoute: { ordering: [city], totalCost: 0, legs: [] },
    savingsVsNaive: 0,
    iataCodes: {},
    dates: { [city]: { arrival: '2027-01-10', departure: '2027-01-13' } },
  }) as any;

describe('"I know my budget" (B1)', () => {
  it('with no destination and no vibe, asks the suggester for the best-value trip instead of failing', async () => {
    mockedVibe.mockResolvedValue({
      suggestions: [{ destination_city: 'Mexico City', destination_country: 'Mexico', why_it_fits_vibe: 'Value.' }],
      reasoning_summary: '',
    } as any);
    mockedOptimize.mockResolvedValue(optimizeFor('Mexico City'));

    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem(
      'bluemurr-autorun',
      JSON.stringify({
        origin: 'Seattle',
        originAirports: ['SEA'],
        travelers: 1,
        budget: 1500,
        budgetPerPerson: true,
        returnToHome: false,
        planningMode: 'budget',
      }),
    );
    render(<PlanningChat />);

    await waitFor(() => expect(mockedVibe).toHaveBeenCalledTimes(1));
    expect(mockedVibe.mock.calls[0][0]).toMatchObject({
      origin: 'Seattle',
      budgetPerPerson: 1500,
      travelWindow: 'flexible',
    });
    expect(mockedVibe.mock.calls[0][0].vibe).toMatch(/open to anything/i);
    await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));
    expect(mockedOptimize.mock.calls[0][0].cities).toEqual([{ name: 'Mexico City' }]);
    expect(screen.queryByText(/at least one city or country/)).toBeNull();
  });
});

describe('Adjust trip after a reload (M1)', () => {
  it('a guided search keeps its conversation in the tab for a reload', async () => {
    mockedOptimize.mockResolvedValue(optimizeFor('Paris'));
    window.history.pushState({}, '', '/plan');
    const first = render(<PlanningChat />);
    useTripStore.setState({
      answers: {
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
      },
    });
    fireEvent.click(await screen.findByText('I know where I want to go'));
    const bar = await screen.findByPlaceholderText('Type a destination...');
    fireEvent.change(bar, { target: { value: 'Paris' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    fireEvent.click(await screen.findByText('Find my trip', undefined, { timeout: 3000 }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results'));
    first.unmount();
    expect(sessionStorage.getItem('bluemurr-planning-session')).not.toBeNull();

    // The reload half is in adjustTripAfterReload.test.tsx (a fresh module,
    // so nothing is left in memory — only this tab's storage).
    const snap = JSON.parse(sessionStorage.getItem('bluemurr-planning-session')!);
    expect(snap.guided.intent).toBe('place');
    expect(snap.answers.destinations).toEqual(['Paris']);
  }, 20_000);
});

describe('dates in the past (m4)', () => {
  it('are refused at the date step, not after Find my trip', async () => {
    window.history.pushState({}, '', '/plan');
    render(<PlanningChat />);
    useTripStore.setState({
      answers: { origin: 'New York', originAirports: ['JFK'], returnToHome: true, vibe: 'Culture' },
    });
    fireEvent.click(await screen.findByText('I know where I want to go'));
    const bar = await screen.findByPlaceholderText('Type a destination...');
    fireEvent.change(bar, { target: { value: 'Rome' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    const dates = await screen.findByPlaceholderText(/Or type when/, undefined, { timeout: 3000 });
    fireEvent.change(dates, { target: { value: 'March 10 2024' } });
    fireEvent.keyDown(dates, { key: 'Enter' });
    expect(await screen.findByText(/That date has already passed/)).toBeInTheDocument();
    expect(useTripStore.getState().answers.dateRange).toBeUndefined();
  }, 20_000);
});

describe('missing prices notice (M2)', () => {
  const city = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, hotel: { name: 'H' }, hotels: [{ name: 'H' }], ...extra }) as any;

  it('names the home flights and hotel a no-route trip could not price', () => {
    expect(
      missingPriceParts({
        cities: [city('Tristan da Cunha', { hotel: { name: '' }, hotels: [] })],
        origin: { city: 'New York', airports: ['JFK'], outboundLeg: null, returnLeg: null },
        returnToHome: true,
      } as any),
    ).toEqual([
      'flights from New York to Tristan da Cunha',
      'flights from Tristan da Cunha back to New York',
      'a hotel in Tristan da Cunha',
    ]);
  });

  it('says nothing for a fully priced trip, and skips the return on a one-way trip', () => {
    const leg = { price: 100 } as any;
    expect(
      missingPriceParts({
        cities: [city('Rome')],
        origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg, returnLeg: leg },
        returnToHome: true,
      } as any),
    ).toEqual([]);
    expect(
      missingPriceParts({
        cities: [city('Rome')],
        origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg, returnLeg: null },
        returnToHome: false,
      } as any),
    ).toEqual([]);
  });

  it('names an inter-city leg nothing was found for', () => {
    expect(
      missingPriceParts({
        cities: [city('Lisbon', { transportOut: { unavailable: true } }), city('Sintra')],
      } as any),
    ).toEqual(['a way from Lisbon to Sintra']);
  });
});
