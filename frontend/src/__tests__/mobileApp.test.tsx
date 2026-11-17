import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { converse } from '@/lib/api';
import MobileItinerary, { legTransport } from '@/components/mobile/MobileItinerary';
import MobilePlanner from '@/components/mobile/MobilePlanner';
import PlanningChat from '@/components/planning/PlanningChat';
import AIChatPanel from '@/components/results/AIChatPanel';
import { shiftDates, offsetToLead, installDemoApi, demoTrip } from '@/components/mobile/demoApi';
import rawDemoTrip from '@/data/mobile-demo/demoTrip.json';
import demoChat from '@/data/mobile-demo/demoChat.json';
import type { HomeLeg, Trip } from '@/lib/types';

const mockedConverse = converse as jest.MockedFunction<typeof converse>;

const homeLeg = (over: Partial<HomeLeg> = {}): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'CDG',
  price: 900,
  currency: 'USD',
  durationMinutes: 450,
  operator: 'Air France',
  carrierCode: 'AF',
  departTime: '19:30',
  arriveTime: '08:50',
  departDate: '2026-06-14',
  stops: 0,
  bookingUrl: null,
  ...over,
});

function tripWithHome(): Trip {
  const t = buildTrip();
  return {
    ...t,
    origin: {
      city: 'New York',
      airports: ['JFK', 'EWR'],
      outboundLeg: homeLeg({ alternatives: [homeLeg({ operator: 'Delta', price: 820 })] }),
      returnLeg: homeLeg({ originAirport: 'LHR', destAirport: 'JFK', operator: 'British Airways', departDate: '2026-06-22' }),
    },
    returnToHome: true,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null, priceMode: 'total' });
});

describe('MobileItinerary (the vertical flowchart)', () => {
  const props = (trip: Trip) => ({
    trip,
    editable: true,
    homeLegSearch: { outbound: false, return: false },
    refreshingLegs: [],
    onOpenCity: jest.fn(),
    onOpenLeg: jest.fn(),
    onNightsChange: jest.fn(),
    onAddCity: jest.fn(),
    onEditHome: jest.fn(),
  });

  it('draws home → each city → home, with a leg between every pair', () => {
    const trip = tripWithHome();
    useTripStore.setState({ currentTrip: trip });
    render(<MobileItinerary {...props(trip)} />);
    expect(screen.getAllByTestId('m-home-card')).toHaveLength(2);
    expect(screen.getAllByTestId('m-city-card')).toHaveLength(trip.cities.length);
    // outbound + (cities − 1) + return
    expect(screen.getAllByTestId('m-leg')).toHaveLength(trip.cities.length + 1);
    expect(screen.getByText(/Air France · 19:30/)).toBeInTheDocument();
  });

  it('a city tap opens its guide, a leg tap its sheet, and the nights stepper changes nights', () => {
    const trip = tripWithHome();
    useTripStore.setState({ currentTrip: trip });
    const p = props(trip);
    render(<MobileItinerary {...p} />);
    fireEvent.click(screen.getAllByTestId('m-city-card')[1]);
    expect(p.onOpenCity).toHaveBeenCalledWith(1);
    fireEvent.click(within(screen.getAllByTestId('m-leg')[0]).getByRole('button'));
    expect(p.onOpenLeg).toHaveBeenCalledWith({ kind: 'outbound' });
    fireEvent.click(within(screen.getAllByTestId('m-leg')[1]).getByRole('button'));
    expect(p.onOpenLeg).toHaveBeenCalledWith({ kind: 'city', index: 0 });
    const first = trip.cities[0];
    fireEvent.click(screen.getByLabelText(`One more night in ${first.name}`));
    expect(p.onNightsChange).toHaveBeenCalledWith(0, expect.any(Number));
    // The stepper must not also open the guide.
    expect(p.onOpenCity).toHaveBeenCalledTimes(1);
  });

  it('a read-only trip shows no steppers and no add-city', () => {
    const trip = tripWithHome();
    useTripStore.setState({ currentTrip: trip });
    render(<MobileItinerary {...props(trip)} editable={false} />);
    expect(screen.queryByTestId('m-add-city')).toBeNull();
    expect(screen.queryByLabelText(/One more night/)).toBeNull();
  });

  it('legTransport resolves home flights with their alternatives', () => {
    const trip = tripWithHome();
    const out = legTransport(trip, { kind: 'outbound' })!;
    expect(out.from).toBe('New York');
    expect(out.to).toBe(trip.cities[0].name);
    expect(out.alternatives?.[0].operator).toBe('Delta');
    const ret = legTransport(trip, { kind: 'return' })!;
    expect(ret.to).toBe('New York');
    expect(legTransport(trip, { kind: 'city', index: 0 })).toBe(trip.cities[0].transportOut);
  });
});

describe('MobilePlanner', () => {
  const base = {
    onFindTrip: jest.fn(),
    findTripLoading: false,
    findTripStatus: '',
    findTripError: null,
    onSwitchToGuided: jest.fn(),
  };

  it('talks to /api/plan/converse and offers its quick replies above the input', async () => {
    mockedConverse.mockResolvedValue({
      reply: 'Paris and London — where are you flying from?',
      updates: { destinations: ['Paris', 'London'] },
      action: 'ask',
      quickReplies: ['New York', 'Boston'],
    } as any);
    render(<MobilePlanner {...base} />);
    fireEvent.change(screen.getByLabelText('Message BlueMurr'), { target: { value: 'Paris and London' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(await screen.findByText(/where are you flying from/)).toBeInTheDocument();
    expect(mockedConverse).toHaveBeenCalledWith(expect.objectContaining({ message: 'Paris and London' }));
    expect(useTripStore.getState().answers.destinations).toEqual(['Paris', 'London']);
    const chips = screen.getByTestId('m-quick-replies');
    fireEvent.click(within(chips).getByText('New York'));
    await waitFor(() => expect(mockedConverse).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'New York' })));
  });

  it('the vibe picker opens as a sheet when the AI asks for it', async () => {
    mockedConverse.mockResolvedValue({ reply: 'What vibe?', updates: {}, action: 'show_vibe_picker' } as any);
    render(<MobilePlanner {...base} />);
    fireEvent.change(screen.getByLabelText('Message BlueMurr'), { target: { value: 'Italy' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(await screen.findByTestId('m-vibe-sheet')).toBeInTheDocument();
  });

  it('the dates sheet sends the picked dates through the conversation', async () => {
    useTripStore.setState({ answers: { destinations: ['Paris'] } });
    render(<MobilePlanner {...base} />);
    fireEvent.click(screen.getByRole('button', { name: /Pick dates/ }));
    const sheet = await screen.findByTestId('m-dates-sheet');
    fireEvent.change(within(sheet).getByLabelText('Leave'), { target: { value: '2027-01-12' } });
    fireEvent.change(within(sheet).getByLabelText('Come back'), { target: { value: '2027-01-19' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use these dates' }));
    await waitFor(() =>
      expect(mockedConverse).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Dates: Jan 12.* to Jan 19/) })),
    );
  });
});

describe('PlanningChat variant="mobile"', () => {
  it('opens straight into the mobile conversation (no mode picker)', async () => {
    render(<PlanningChat variant="mobile" />);
    expect(await screen.findByTestId('m-planner')).toBeInTheDocument();
    expect(screen.queryByText('What kind of trip are you planning?')).toBeNull();
  });

  it('the desktop planner is unchanged: it still asks what kind of trip', async () => {
    render(<PlanningChat />);
    expect(await screen.findByText('What kind of trip are you planning?')).toBeInTheDocument();
    expect(screen.queryByTestId('m-planner')).toBeNull();
  });
});

describe('AIChatPanel appearance="sheet"', () => {
  it('draws the same chat on the dark surface without its own header', () => {
    const trip = buildTrip();
    useTripStore.setState({ currentTrip: trip });
    const { container } = render(<AIChatPanel trip={trip} appearance="sheet" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.appearance).toBe('sheet');
    expect(root.style.background).toBe('rgb(15, 15, 26)');
    expect(screen.queryByText('Tweak your trip in plain English')).toBeNull();
    expect(screen.getByPlaceholderText('Ask about your trip...')).toBeInTheDocument();
  });

  it('the desktop panel keeps its header and light surface', () => {
    const trip = buildTrip();
    useTripStore.setState({ currentTrip: trip });
    const { container } = render(<AIChatPanel trip={trip} />);
    expect((container.firstElementChild as HTMLElement).dataset.appearance).toBe('panel');
    expect(screen.getByText('Tweak your trip in plain English')).toBeInTheDocument();
  });
});

describe('/m/demo fixtures', () => {
  it('shiftDates moves values and keys (a schedule is keyed by day)', () => {
    const out = shiftDates({ d: '2027-01-31', t: '2027-01-31T08:30', s: { '2027-01-31': ['x'] }, n: 'Paris' }, 1);
    expect(out).toEqual({ d: '2027-02-01', t: '2027-02-01T08:30', s: { '2027-02-01': ['x'] }, n: 'Paris' });
  });

  it('offsetToLead puts the first day the given number of days out', () => {
    // Nov 17 + 30 days = Dec 17, which is 26 days before Jan 12.
    expect(offsetToLead('2027-01-12', 30, new Date(2026, 10, 17))).toBe(-26);
    expect(offsetToLead('2026-11-01', 30, new Date(2026, 10, 17))).toBe(46);
  });

  it('the demo trip starts about a month out and is never treated as saved', () => {
    const { trip } = demoTrip(rawDemoTrip as unknown as Trip);
    expect(trip.id).toBe('mock-demo');
    const start = new Date(`${trip.origin!.outboundLeg!.departDate}T00:00:00`);
    const days = Math.round((start.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
    expect(days).toBe(30);
    expect(trip.cities.map((c) => c.name)).toEqual(['Paris', 'London']);
    expect(trip.cities.every((c) => c.hotels.length > 0)).toBe(true);
  });

  it('answers the app API from the script and lets every other request through', async () => {
    // jsdom has no fetch Response; a minimal one is enough here.
    (global as any).Response ??= class {
      status: number;
      ok: boolean;
      constructor(private body: string, init: { status?: number } = {}) {
        this.status = init.status ?? 200;
        this.ok = this.status < 400;
      }
      async json() {
        return JSON.parse(this.body);
      }
    };
    const real = jest.fn().mockResolvedValue(new Response('tile'));
    const original = window.fetch;
    window.fetch = real as any;
    const uninstall = installDemoApi('http://localhost:4000', demoChat as any, 0);
    try {
      const chat = await fetch('http://localhost:4000/api/plan/chat', { method: 'POST', body: JSON.stringify({ message: 'Add a night in Paris' }) });
      expect((await chat.json()).type).toBe('proposal');
      const other = await fetch('http://localhost:4000/api/plan/chat', { method: 'POST', body: JSON.stringify({ message: 'hello' }) });
      expect((await other.json()).type).toBe('answer');
      const save = await fetch('http://localhost:4000/api/trips', { method: 'POST' });
      expect(save.status).toBe(503);
      await fetch('https://tiles.openfreemap.org/styles/positron');
      expect(real).toHaveBeenCalledTimes(1);
      expect(String(real.mock.calls[0][0])).toContain('openfreemap');
    } finally {
      uninstall();
      window.fetch = original;
    }
  });
});
