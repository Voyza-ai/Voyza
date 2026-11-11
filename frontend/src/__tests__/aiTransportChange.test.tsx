import './mocks';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useTripStore } from '@/store/tripStore';
import { planChat } from '@/lib/api';
import type { LegChoice, LegOptionsPayload, TransportChangeProposal } from '@/lib/api';
import { applyLegOptions, applyTransportChange, transportChangeApplies } from '@/lib/transportChange';
import { liveTripTotal } from '@/lib/tripTotals';
import type { Trip } from '@/lib/types';
import tripJson from './chatTripNycParisLondon.json';

/**
 * Accepting the AI chat's transport changes — the flights to and from home
 * included — on the real production trip (New York → Paris → London,
 * Jan 12–17 2027, 2 travellers; the results page's session snapshot).
 *
 * Each proposal below is the one the backend builds for that ask
 * (backend/src/tests/planChatHomeLegs.test.ts, same trip, same fares). Every
 * test reads the trip back after Accept: the leg carries exactly the chosen
 * option, the header total (liveTripTotal) moves by exactly the difference
 * the backend stated, and nothing else — no other leg, hotel or date — moved.
 */

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const trip = (): Trip => JSON.parse(JSON.stringify(tripJson));

const choice = (c: Partial<LegChoice> & Pick<LegChoice, 'optionId' | 'operator' | 'price'>): LegChoice => ({
  mode: 'flight',
  flightNumber: null,
  departTime: null,
  arriveTime: null,
  departDate: null,
  arriveDate: null,
  fromAirport: null,
  toAirport: null,
  durationMinutes: 480,
  duration: '8h',
  stops: 0,
  currency: 'USD',
  bookingUrl: null,
  ...c,
});

const RETURN = { id: 'London→home', kind: 'return' as const, index: 1, from: 'London', to: 'New York', date: '2027-01-17' };
const OUTBOUND = { id: 'home→Paris', kind: 'outbound' as const, index: -1, from: 'New York', to: 'Paris', date: '2027-01-12' };
const PARIS_LONDON = { id: 'Paris→London', kind: 'intercity' as const, index: 0, from: 'Paris', to: 'London', date: '2027-01-15' };

const currentReturn = choice({
  optionId: 'London→home#0', operator: 'American Airlines', flightNumber: 'AA', departTime: '12:23', arriveTime: '15:24',
  departDate: '2027-01-17', arriveDate: '2027-01-17', fromAirport: 'LON', toAirport: 'JFK', durationMinutes: 481, price: 432.18,
});

/** "switch my flight home to the British Airways one" — card option #1. */
const toBritishAirways = (): TransportChangeProposal => ({
  kind: 'transport_change',
  toolName: 'select_transport_option',
  leg: RETURN,
  before: currentReturn,
  after: choice({
    optionId: 'London→home#1', operator: 'British Airways', flightNumber: 'BA', departTime: '12:23', arriveTime: '15:25',
    departDate: '2027-01-17', arriveDate: '2027-01-17', fromAirport: 'LON', toAirport: 'EWR', durationMinutes: 482, price: 435.36,
  }),
  request: { optionId: 'London→home#1' },
  priceDelta: 3.18,
  firstStay: null,
  totals: { before: 1576, after: 1579, delta: 3 },
});

/** "change my flight home … to a later one, in the evening" — found by search, not on the card. */
const laterEveningHome = (): TransportChangeProposal => ({
  kind: 'transport_change',
  toolName: 'find_transport_option',
  leg: RETURN,
  before: currentReturn,
  after: choice({
    optionId: 'London→home~6', operator: 'Virgin Atlantic', flightNumber: 'VS', departTime: '18:05', arriveTime: '21:15',
    departDate: '2027-01-17', arriveDate: '2027-01-17', fromAirport: 'LON', toAirport: 'EWR', price: 455.1,
  }),
  request: { relative: 'later', timeOfDay: 'evening' },
  priceDelta: 22.92,
  firstStay: null,
  totals: { before: 1576, after: 1599, delta: 23 },
});

/** "cheaper flight home". */
const cheaperHome = (): TransportChangeProposal => ({
  ...laterEveningHome(),
  after: choice({
    optionId: 'London→home~1', operator: 'Delta', flightNumber: 'DL', departTime: '07:10', arriveTime: '10:05',
    departDate: '2027-01-17', arriveDate: '2027-01-17', fromAirport: 'LON', toAirport: 'LGA', price: 399,
  }),
  request: { cheaper: true },
  priceDelta: -33.18,
  totals: { before: 1576, after: 1543, delta: -33 },
});

/** "later flight out of New York" — overnight, lands Jan 13: Paris starts a day later. */
const laterOut = (): TransportChangeProposal => ({
  kind: 'transport_change',
  toolName: 'find_transport_option',
  leg: OUTBOUND,
  before: choice({
    optionId: 'home→Paris#0', operator: 'British Airways', flightNumber: 'BA', departTime: '08:30', arriveTime: '22:48',
    departDate: '2027-01-12', arriveDate: '2027-01-12', fromAirport: 'JFK', toAirport: 'PAR', durationMinutes: 498, price: 449.76,
  }),
  after: choice({
    optionId: 'home→Paris~3', operator: 'Delta', flightNumber: 'DL', departTime: '21:15', arriveTime: '10:40',
    departDate: '2027-01-12', arriveDate: '2027-01-13', fromAirport: 'JFK', toAirport: 'PAR', price: 462,
  }),
  request: { relative: 'later' },
  priceDelta: 12.24,
  firstStay: { city: 'Paris', arrivalBefore: '2027-01-12', arrivalAfter: '2027-01-13', nightsBefore: 3, nightsAfter: 2, hotelDelta: -131.57 },
  totals: { before: 1576, after: 1456, delta: -120 },
});

/** "Paris → London, later". */
const laterParisLondon = (): TransportChangeProposal => ({
  kind: 'transport_change',
  toolName: 'find_transport_option',
  leg: PARIS_LONDON,
  before: choice({
    optionId: 'Paris→London#0', operator: 'American Airlines', flightNumber: 'AA', departTime: '10:50', arriveTime: '10:48',
    departDate: '2027-01-15', duration: '58m', durationMinutes: 58, price: 79.84,
  }),
  after: choice({
    optionId: 'Paris→London~4', operator: 'Air France', flightNumber: 'AF', departTime: '14:05', arriveTime: '14:20',
    departDate: '2027-01-15', duration: '1h 15m', durationMinutes: 75, price: 95.1,
  }),
  request: { relative: 'later' },
  priceDelta: 15.26,
  firstStay: null,
  totals: { before: 1576, after: 1591, delta: 15 },
});

/** The trip minus the generated schedules (they follow the transport by design). */
const withoutSchedules = (t: Trip) => ({
  ...t,
  cities: t.cities.map(({ schedule: _s, unscheduled: _u, ...c }) => c),
});

/** Assert that `next` differs from `before` only where `paths` say. */
function expectOnlyChanged(before: Trip, next: Trip, paths: Array<(t: any) => void>) {
  const a: any = JSON.parse(JSON.stringify(withoutSchedules(before)));
  const b: any = JSON.parse(JSON.stringify(withoutSchedules(next)));
  for (const clear of paths) {
    clear(a);
    clear(b);
  }
  expect(b).toEqual(a);
}

describe('the fixture', () => {
  it('is the production trip at its $1,576 header total', () => {
    expect(liveTripTotal(trip())).toBe(1576);
  });
});

describe('applyTransportChange', () => {
  it('flight home → the British Airways card option: exactly that flight, +$3 on the header, nothing else moved', () => {
    const t = trip();
    const p = toBritishAirways();
    const next = applyTransportChange(t, p);
    expect(next.origin!.returnLeg).toMatchObject({
      operator: 'British Airways', carrierCode: 'BA', departTime: '12:23', arriveTime: '15:25', departDate: '2027-01-17',
      originAirport: 'LON', destAirport: 'EWR', price: 435.36,
    });
    // The old pick goes first among the alternatives; the chosen one leaves them.
    expect(next.origin!.returnLeg!.alternatives!.map((a) => `${a.operator} ${a.destAirport} ${a.price}`)).toEqual([
      'American Airlines JFK 432.18', 'Iberia JFK 438.66', 'American Airlines EWR 443.66',
    ]);
    expect(liveTripTotal(next) - liveTripTotal(t)).toBe(p.totals!.delta);
    expect(liveTripTotal(next)).toBe(p.totals!.after);
    expectOnlyChanged(t, next, [(x) => delete x.origin.returnLeg]);
    // The day's generated travel block follows the new flight.
    const lastDay = next.cities[1].schedule!['2027-01-17'];
    expect(lastDay.some((e) => e.auto && /LON → EWR/.test(e.title) && e.startTime === '12:23')).toBe(true);
  });

  it('flight home → a later evening flight found by search: becomes the leg, +$23, old pick kept as an option', () => {
    const t = trip();
    const p = laterEveningHome();
    const next = applyTransportChange(t, p);
    expect(next.origin!.returnLeg).toMatchObject({
      operator: 'Virgin Atlantic', carrierCode: 'VS', departTime: '18:05', arriveTime: '21:15', departDate: '2027-01-17',
      arriveDate: '2027-01-17', originAirport: 'LON', destAirport: 'EWR', price: 455.1,
    });
    expect(next.origin!.returnLeg!.alternatives!.map((a) => a.operator)).toEqual([
      'American Airlines', 'British Airways', 'Iberia', 'American Airlines',
    ]);
    expect(liveTripTotal(next) - liveTripTotal(t)).toBe(23);
    expectOnlyChanged(t, next, [(x) => delete x.origin.returnLeg]);
    const lastDay = next.cities[1].schedule!['2027-01-17'];
    expect(lastDay.find((e) => e.auto && /^Flight/.test(e.title))).toMatchObject({ startTime: '18:05', endTime: '21:15' });
  });

  it('cheaper flight home: −$33', () => {
    const t = trip();
    const next = applyTransportChange(t, cheaperHome());
    expect(next.origin!.returnLeg).toMatchObject({ operator: 'Delta', destAirport: 'LGA', departTime: '07:10', price: 399 });
    expect(liveTripTotal(next) - liveTripTotal(t)).toBe(-33);
    expectOnlyChanged(t, next, [(x) => delete x.origin.returnLeg]);
  });

  it('later flight out of New York: the new outbound, Paris starting the day it lands, −$120 exactly as shown', () => {
    const t = trip();
    const p = laterOut();
    const next = applyTransportChange(t, p);
    expect(next.origin!.outboundLeg).toMatchObject({
      operator: 'Delta', departTime: '21:15', arriveTime: '10:40', departDate: '2027-01-12', arriveDate: '2027-01-13', originAirport: 'JFK', price: 462,
    });
    expect(next.cities[0].dates).toEqual({ arrival: '2027-01-13', departure: '2027-01-15' });
    expect(liveTripTotal(next) - liveTripTotal(t)).toBe(p.totals!.delta);
    // The outbound and the first stay's arrival are the only changes.
    expectOnlyChanged(t, next, [(x) => delete x.origin.outboundLeg, (x) => delete x.cities[0].dates.arrival]);
  });

  it('Paris → London, later: the leg on both cities, +$15', () => {
    const t = trip();
    const next = applyTransportChange(t, laterParisLondon());
    expect(next.cities[0].transportOut).toMatchObject({ operator: 'Air France', departTime: '14:05', arriveTime: '14:20', price: 95.1, from: 'Paris', to: 'London', departDate: '2027-01-15' });
    expect(next.cities[1].transportIn).toMatchObject({ operator: 'Air France', departTime: '14:05', price: 95.1 });
    expect(next.cities[1].transportIn.alternatives).toBeUndefined();
    expect(next.cities[0].transportOut.alternatives!.map((a) => a.operator)).toEqual(['American Airlines', 'British Airways', 'Iberia', 'easyJet']);
    expect(liveTripTotal(next) - liveTripTotal(t)).toBe(15);
    expectOnlyChanged(t, next, [(x) => delete x.cities[0].transportOut, (x) => delete x.cities[1].transportIn]);
    // The home flights are untouched.
    expect(next.origin).toBe(t.origin);
  });

  it('applies nothing when the leg changed since the proposal (the user picked another flight on the card)', () => {
    const t = trip();
    useTripStore.setState({ currentTrip: t });
    useTripStore.getState().setHomeLegAlternative('return', 1);
    const changed = useTripStore.getState().currentTrip!;
    expect(transportChangeApplies(changed, laterEveningHome())).toBe(false);
    expect(applyTransportChange(changed, laterEveningHome())).toBe(changed);
    expect(transportChangeApplies(t, laterEveningHome())).toBe(true);
  });
});

describe('applyLegOptions', () => {
  it('puts listed evening flights home on the card first and changes neither the selection nor the total', () => {
    const t = trip();
    const payload: LegOptionsPayload = {
      leg: RETURN,
      totalFound: 3,
      options: [laterEveningHome().after, choice({ optionId: 'London→home~7', operator: 'American Airlines', departTime: '20:40', arriveTime: '23:50', departDate: '2027-01-17', fromAirport: 'LON', toAirport: 'JFK', price: 468.9 })],
    };
    const next = applyLegOptions(t, payload);
    const ret = next.origin!.returnLeg!;
    expect({ ...ret, alternatives: undefined }).toEqual({ ...t.origin!.returnLeg!, alternatives: undefined });
    expect(ret.alternatives!.map((a) => `${a.operator} ${a.departTime}`)).toEqual([
      'Virgin Atlantic 18:05', 'American Airlines 20:40', 'British Airways 12:23', 'Iberia 12:23',
    ]);
    expect(liveTripTotal(next)).toBe(liveTripTotal(t));
    expectOnlyChanged(t, next, [(x) => delete x.origin.returnLeg.alternatives]);
  });
});

describe('AIChatPanel — transport change card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTripStore.setState({ currentTrip: trip(), tripPicks: null, priceMode: 'total' });
  });

  async function ask(response: any, text = 'Change my flight home from London to a later one, in the evening') {
    mockedPlanChat.mockResolvedValueOnce(response);
    render(<AIChatPanel trip={useTripStore.getState().currentTrip!} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest('form')!);
  }

  const proposalReply = (p: TransportChangeProposal) => ({ type: 'proposal' as const, reply: 'The cheapest later evening flight …', proposal: p });

  it('shows the flight home now → new and the header total before → after', async () => {
    await ask(proposalReply(laterEveningHome()));
    const card = await screen.findByTestId('transport-change-card');
    expect(within(card).getByText('Change flight home')).toBeInTheDocument();
    expect(within(card).getByTestId('transport-row-now')).toHaveTextContent('American Airlines');
    expect(within(card).getByTestId('transport-row-now')).toHaveTextContent('LON 12:23 → JFK 15:24');
    expect(within(card).getByTestId('transport-row-new')).toHaveTextContent('Virgin Atlantic');
    expect(within(card).getByTestId('transport-row-new')).toHaveTextContent('LON 18:05 → EWR 21:15');
    expect(within(card).getByTestId('transport-row-new')).toHaveTextContent('$455');
    expect(within(card).getByTestId('transport-change-total')).toHaveTextContent('$1,576→$1,599+$23');
  });

  it('Accept switches exactly the flight home, and the header total moves by exactly the shown +$23', async () => {
    const before = useTripStore.getState().currentTrip!;
    await ask(proposalReply(laterEveningHome()));
    const card = await screen.findByTestId('transport-change-card');
    fireEvent.click(within(card).getByText('Accept'));
    const after = useTripStore.getState().currentTrip!;
    expect(after.origin!.returnLeg).toMatchObject({ operator: 'Virgin Atlantic', departTime: '18:05', arriveTime: '21:15', departDate: '2027-01-17', destAirport: 'EWR', price: 455.1 });
    expect(liveTripTotal(after) - liveTripTotal(before)).toBe(23);
    expectOnlyChanged(before, after, [(x) => delete x.origin.returnLeg]);
    expect(within(card).getByText('✓ Applied to your trip')).toBeInTheDocument();
  });

  it('Accept on the outbound moves the first stay as the card says', async () => {
    await ask(proposalReply(laterOut()), 'later flight out of New York');
    const card = await screen.findByTestId('transport-change-card');
    expect(card).toHaveTextContent('Paris starts Jan 13: 2 nights instead of 3');
    expect(within(card).getByTestId('transport-change-total')).toHaveTextContent('$1,576→$1,456−$120');
    fireEvent.click(within(card).getByText('Accept'));
    const after = useTripStore.getState().currentTrip!;
    expect(after.origin!.outboundLeg).toMatchObject({ operator: 'Delta', departTime: '21:15' });
    expect(after.cities[0].dates.arrival).toBe('2027-01-13');
    expect(liveTripTotal(after)).toBe(1456);
  });

  it('shows per-person amounts when the header does, moving by exactly what the header moves', async () => {
    useTripStore.setState({ priceMode: 'perPerson' });
    await ask(proposalReply(laterEveningHome()));
    const card = await screen.findByTestId('transport-change-card');
    // Header per person: round(1576 / 2) = 788 → round(1599 / 2) = 800.
    expect(within(card).getByTestId('transport-change-total')).toHaveTextContent('$788→$800+$12');
    expect(card).toHaveTextContent('per person');
  });

  it('Reject leaves the trip exactly as it was', async () => {
    const before = useTripStore.getState().currentTrip;
    await ask(proposalReply(toBritishAirways()), 'switch my flight home to the British Airways one');
    const card = await screen.findByTestId('transport-change-card');
    fireEvent.click(within(card).getByText('Reject'));
    expect(useTripStore.getState().currentTrip).toBe(before);
    expect(within(card).getByText(/Dismissed — your trip is unchanged/)).toBeInTheDocument();
    expect(within(card).queryByText('Accept')).not.toBeInTheDocument();
  });

  it('does not apply a proposal whose leg changed before Accept, and says so', async () => {
    await ask(proposalReply(laterEveningHome()));
    const card = await screen.findByTestId('transport-change-card');
    act(() => useTripStore.getState().setHomeLegAlternative('return', 0));
    const picked = useTripStore.getState().currentTrip;
    fireEvent.click(within(card).getByText('Accept'));
    expect(useTripStore.getState().currentTrip).toBe(picked);
    expect(within(card).getByText(/Not applied/)).toBeInTheDocument();
    expect(await screen.findByText(/That leg changed since I proposed this/)).toBeInTheDocument();
  });

  it('listed options land on the flight-home card; the flight and the total stay', async () => {
    const before = useTripStore.getState().currentTrip!;
    await ask(
      {
        type: 'leg_options',
        reply: 'Evening flight options for London → New York on Jan 17: …',
        legOptions: { leg: RETURN, totalFound: 1, options: [laterEveningHome().after] },
      },
      'Show me evening flights from London back to New York on Jan 17',
    );
    await screen.findByText(/Evening flight options/);
    const after = useTripStore.getState().currentTrip!;
    expect(after.origin!.returnLeg!.operator).toBe('American Airlines');
    expect(after.origin!.returnLeg!.departTime).toBe('12:23');
    expect(after.origin!.returnLeg!.alternatives![0]).toMatchObject({ operator: 'Virgin Atlantic', departTime: '18:05' });
    expect(liveTripTotal(after)).toBe(liveTripTotal(before));
    expect(screen.queryByTestId('transport-change-card')).not.toBeInTheDocument();
  });

  it('on the canvas, Accept goes to the host', async () => {
    const onTripUpdate = jest.fn();
    const t = trip();
    mockedPlanChat.mockResolvedValueOnce(proposalReply(cheaperHome()));
    render(<AIChatPanel trip={t} onTripUpdate={onTripUpdate} getLatestTrip={() => t} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'cheaper flight home' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(within(await screen.findByTestId('transport-change-card')).getByText('Accept'));
    expect(onTripUpdate).toHaveBeenCalledTimes(1);
    expect(onTripUpdate.mock.calls[0][0].origin.returnLeg).toMatchObject({ operator: 'Delta', price: 399 });
    expect(liveTripTotal(onTripUpdate.mock.calls[0][0]) - liveTripTotal(t)).toBe(-33);
  });
});
