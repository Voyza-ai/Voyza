/**
 * The Schedule follows trip edits — the owner's trip, reproduced on
 * bluemurr.com 2026-11-16: New York → Paris → London, Jan 12–17 2027, two
 * travellers, planned by the planner and then edited on the results page.
 *
 * Every edit here goes through the real results page: the AI chat's Accept
 * (the server's proposal mocked, as it answered live) and the city card's
 * − / + nights, with the searches those start mocked. The Schedule tab is
 * then opened and every day is checked the way the traveller reads it:
 *
 *   - arrival day: nothing planned before the traveller has landed (+1h);
 *   - leaving: nothing over "Head to …" or the flight, and both blocks are
 *     there, the flight home included, at the flight's real time;
 *   - a day the stay gained is planned, not empty; nothing overlaps;
 *   - travel blocks name both airports, never "the airport".
 *
 * Measured before the fix (the same flows): after "Give Paris one more
 * night" London's Jan 16 kept its old full day — breakfast 08:00, a museum
 * 09:05–12:05, lunch 12:30 — under a flight that lands 11:41, and Jan 17 was
 * empty; the Paris → London block read "Flight the airport → London".
 */
import './mocks';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResultsPage from '@/app/results/page';
import { useTripStore } from '@/store/tripStore';
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';
import { compareLeg, fetchHomeLegs, planChat, searchHotels } from '@/lib/api';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import type { City, HomeLeg, ScheduledEvent, Transport, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

jest.mock('@/lib/tripHubs', () => ({
  useDayHubs: () => ({ arrive: null, departs: [] }),
}));

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;
const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;
const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// ── The trip as the planner built it (flights as found live) ─────────────────

const home = (over: Partial<HomeLeg>): HomeLeg => ({
  originAirport: 'EWR',
  destAirport: 'PAR',
  price: 449.86,
  currency: 'USD',
  durationMinutes: 500,
  operator: 'British Airways',
  carrierCode: 'BA',
  departTime: '08:30',
  arriveTime: '22:50',
  departDate: '2027-01-12',
  arriveDate: '2027-01-12',
  stops: 0,
  bookingUrl: null,
  ...over,
});
const OUTBOUND = home({});
const BACK_JAN17 = home({ originAirport: 'LON', destAirport: 'JFK', operator: 'Iberia', carrierCode: 'IB', price: 432.66, durationMinutes: 481, departTime: '12:23', arriveTime: '15:24', departDate: '2027-01-17', arriveDate: '2027-01-17' });
const BACK_JAN18 = home({ originAirport: 'LON', destAirport: 'LGA', price: 431.84, durationMinutes: 480, departTime: '13:09', arriveTime: '16:09', departDate: '2027-01-18', arriveDate: '2027-01-18' });
const BACK_EDI = home({ originAirport: 'EDI', destAirport: 'EWR', operator: 'American Airlines', carrierCode: 'AA', price: 412, durationMinutes: 514, departTime: '13:09', arriveTime: '15:43', departDate: '2027-01-18', arriveDate: '2027-01-18' });

/** Paris → London: 58 minutes, landing at an earlier clock time (an hour behind). */
const PAR_LON: Transport = {
  mode: 'flight', operator: 'American Airlines', duration: '58m', price: 79.7, from: 'Paris', to: 'London',
  departTime: '10:50', arriveTime: '10:48', departDate: '2027-01-15', layovers: 0, flightNumber: 'AA',
};

const act_ = (name: string, timeOfDay: ActivitySuggestion['timeOfDay'], hours: number, category: ActivitySuggestion['category'] = 'landmark'): ActivitySuggestion =>
  ({ name, category, timeOfDay, durationHours: hours, reason: '' });
const meal = (name: string, cuisine: string, mealType: RestaurantSuggestion['mealType']): RestaurantSuggestion =>
  ({ name, cuisine, priceRange: '$$', mealType, reason: '' });

const PARIS_ACTS = [
  act_('Musée Rodin', 'morning', 2), act_('Marché des Enfants Rouges', 'afternoon', 2),
  act_('Palais Garnier opera house tour', 'morning', 2), act_('Sainte-Chapelle', 'afternoon', 1),
  act_('Le Comptoir du Relais', 'evening', 2, 'food'), act_("Musée d'Orsay", 'morning', 3),
  act_('Latin Quarter walking tour', 'afternoon', 1.5),
];
const PARIS_MEALS = [
  meal('Bouillon Chartier', 'Traditional French', 'breakfast'), meal('Breizh Café', 'Breton crêpes', 'lunch'),
  meal('Frenchie', 'Modern French', 'dinner'), meal("Chez L'Ami Louis", 'Classic French', 'dinner'),
  meal("L'Ami Jean", 'Basque', 'lunch'),
];
const LONDON_ACTS = [
  act_('British Museum', 'morning', 3), act_('Borough Market food tour', 'afternoon', 2, 'food'),
  act_("Shakespeare's Globe Theatre performance", 'evening', 3), act_("Sir John Soane's Museum", 'morning', 2),
  act_("Dennis Severs' House", 'evening', 1),
];
const LONDON_MEALS = [
  meal("Dishoom King's Cross", 'Bombay café', 'breakfast'), meal('Bao Borough', 'Taiwanese buns', 'lunch'),
  meal('St. JOHN Bread and Wine', 'British nose-to-tail', 'dinner'), meal('Kiln', 'Thai', 'dinner'),
  meal('The River Café', 'Italian', 'lunch'),
];

const stay = (name: string, country: string, arrival: string, departure: string, picks: { a: ActivitySuggestion[]; r: RestaurantSuggestion[] }): City =>
  buildCity({
    name,
    country,
    dates: { arrival, departure },
    hotels: [
      { name: `${name} Hotel`, rating: 8, pricePerNight: 200, area: '' },
      { name: `${name} Other`, rating: 7, pricePerNight: 250, area: '' },
    ],
    hotel: { name: `${name} Hotel`, rating: 8, pricePerNight: 200, area: '' },
    selectedHotelIndex: 0,
    activities: picks.a.map((p) => p.name),
    restaurants: picks.r.map((r) => ({ name: r.name, cuisine: r.cuisine, priceRange: r.priceRange })),
    transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
    transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
  });

/** The planned trip: each stay laid out by the planner's own scheduler. */
function plannedTrip(): Trip {
  const paris = { ...stay('Paris', 'France', '2027-01-12', '2027-01-15', { a: PARIS_ACTS, r: PARIS_MEALS }), transportOut: PAR_LON };
  const london = { ...stay('London', 'United Kingdom', '2027-01-15', '2027-01-17', { a: LONDON_ACTS, r: LONDON_MEALS }), transportIn: PAR_LON };
  const t0 = buildTrip({
    title: 'Paris → London',
    travelers: 2,
    savings: 0,
    returnToHome: true,
    dateShiftSuggestion: undefined,
    dateShiftChecked: true,
    cities: [paris, london],
    origin: { city: 'New York', airports: ['JFK', 'EWR', 'LGA'], outboundLeg: OUTBOUND, returnLeg: BACK_JAN17 },
  } as Partial<Trip>);
  const p = buildCityScheduleFromSuggestions(PARIS_ACTS, PARIS_MEALS, paris, 0, t0);
  const l = buildCityScheduleFromSuggestions(LONDON_ACTS, LONDON_MEALS, london, 1, t0);
  const t = { ...t0, cities: [{ ...paris, ...p }, { ...london, ...l }] };
  return { ...t, totalCost: liveTripTotal(t) };
}

// ── What the chat answered live (trimmed to what Accept applies) ─────────────

const chatLegOption = (dep: string, arr: string, dur: string, mins: number) => ({
  mode: 'flight' as const, operator: 'British Airways', flightNumber: 'BA', price: 85.96, currency: 'USD',
  departTime: dep, arriveTime: arr, duration: dur, durationMinutes: mins, stops: 0, bookingUrl: null, priceDelta: 0,
});

const parisOneMoreNight = {
  type: 'proposal',
  reply: 'Adding one more night to Paris. New dates: Paris Jan 12–Jan 16, London Jan 16–Jan 18. Your flight home moves to Jan 18.',
  proposal: {
    kind: 'city_edit', toolName: 'set_min_days', op: { kind: 'dates', city: 'Paris' },
    before: [{ name: 'Paris', arrival: '2027-01-12', departure: '2027-01-15' }, { name: 'London', arrival: '2027-01-15', departure: '2027-01-17' }],
    after: [
      { name: 'Paris', arrival: '2027-01-12', departure: '2027-01-16', status: 'moved' },
      { name: 'London', arrival: '2027-01-16', departure: '2027-01-18', status: 'moved' },
    ],
    removed: [],
    legs: [{ index: 0, from: 'Paris', to: 'London', date: '2027-01-16', options: [chatLegOption('11:36', '11:41', '1h 5m', 65)] }],
    returnLeg: BACK_JAN18,
    note: '',
    constraints: { pinned_cities: [], min_days: [{ city: 'Paris', minNights: 4 }], transport_windows: [] },
  },
} as any;

const replaceLondon = {
  type: 'proposal',
  reply: "Here's your trip with Edinburgh instead of London. Edinburgh takes London's dates.",
  proposal: {
    kind: 'city_edit', toolName: 'replace_city', op: { kind: 'replace', oldCity: 'London', newCity: 'Edinburgh' },
    before: [{ name: 'Paris', arrival: '2027-01-12', departure: '2027-01-16' }, { name: 'London', arrival: '2027-01-16', departure: '2027-01-18' }],
    after: [
      { name: 'Paris', arrival: '2027-01-12', departure: '2027-01-16', status: 'kept' },
      { name: 'Edinburgh', arrival: '2027-01-16', departure: '2027-01-18', status: 'replaced', replaces: 'London' },
    ],
    removed: ['London'],
    legs: [{ index: 0, from: 'Paris', to: 'Edinburgh', date: '2027-01-16', options: [chatLegOption('11:36', '12:20', '1h 44m', 104)] }],
    returnLeg: BACK_EDI,
    note: '',
  },
} as any;

const laterFlightHome = {
  type: 'proposal',
  reply: 'The cheapest later evening flight home: TAP Air Portugal LON 21:25 → EWR 22:55 on Jan 17.',
  proposal: {
    kind: 'transport_change', toolName: 'find_transport_option',
    leg: { id: 'London→home', kind: 'return', index: 1, from: 'London', to: 'New York', date: '2027-01-17' },
    before: {
      optionId: 'London→home#0', mode: 'flight', operator: 'Iberia', flightNumber: 'IB', departTime: '12:23', arriveTime: '15:24',
      departDate: '2027-01-17', arriveDate: '2027-01-17', fromAirport: 'LON', toAirport: 'JFK', durationMinutes: 481, duration: '8h 1m',
      stops: 0, price: 432.66, currency: 'USD', bookingUrl: null,
    },
    after: {
      optionId: 'London→home~10', mode: 'flight', operator: 'TAP Air Portugal', flightNumber: 'TP', departTime: '21:25', arriveTime: '22:55',
      departDate: '2027-01-17', arriveDate: '2027-01-18', fromAirport: 'LON', toAirport: 'EWR', durationMinutes: 1830, duration: '30h 30m',
      stops: 1, price: 866.58, currency: 'USD', bookingUrl: null,
    },
    firstStay: null,
    priceDelta: 433.92,
  },
} as any;

// ── Driving the page ─────────────────────────────────────────────────────────

/** The searches an edit starts: the moved leg, the flight home, the moved hotels. */
function mockSearches(opts: { homeFlightHeld?: Promise<void> } = {}) {
  mockedCompareLeg.mockImplementation(async (p: any) => ({
    flightOption: {
      id: 'x', price: 86, currency: 'USD', departure: `${p.date}T11:36:00`, arrival: `${p.date}T11:41:00`, durationMinutes: 65,
      stops: 0, carrier: 'British Airways', carrierCode: 'BA', bookingUrl: '',
    },
    trainOption: null, cheapest: 'flight', fastest: 'flight', recommendation: 'flight', priceDifference: 0, timeDifference: 0,
  }) as any);
  mockedFetchHomeLegs.mockImplementation(async (p: any) => {
    await opts.homeFlightHeld;
    const day = p.endDate as string;
    return { outboundLeg: null, returnLeg: { ...BACK_JAN18, departDate: day, arriveDate: day } } as any;
  });
  mockedSearchHotels.mockImplementation(async (p: any) =>
    [{ name: `${p.city} Hotel`, rating: 8, pricePerNight: 200, bookingUrl: '' }, { name: `${p.city} Other`, rating: 7, pricePerNight: 250, bookingUrl: '' }] as any,
  );
}

async function acceptFromChat(answer: any, text: string) {
  mockedPlanChat.mockResolvedValueOnce(answer);
  const input = await screen.findByPlaceholderText('Ask about your trip...');
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.submit(input.closest('form')!);
  });
  const accept = await screen.findAllByRole('button', { name: /^Accept/ });
  await act(async () => {
    fireEvent.click(accept[accept.length - 1]);
  });
}

async function openTab(name: 'Schedule' | 'Flowchart' | 'Calendar') {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^${name}$`) })[0]);
  });
}

// ── Reading the Schedule the way ScheduleView lays it out ────────────────────

type Day = { date: string; city: City; index: number; events: ScheduledEvent[] };
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
function scheduleDays(trip: Trip): Day[] {
  const first = trip.cities[0];
  const last = trip.cities[trip.cities.length - 1];
  const out: Day[] = [];
  for (let d = first.dates.arrival; d <= last.dates.departure; d = addDays(d, 1)) {
    let index = trip.cities.findIndex((c) => c.dates.arrival <= d && d < c.dates.departure);
    if (index < 0 && d === last.dates.departure) index = trip.cities.length - 1;
    const city = trip.cities[index];
    out.push({ date: d, city, index, events: [...(city.schedule?.[d] ?? [])].sort((a, b) => toMin(a.startTime) - toMin(b.startTime)) });
  }
  return out;
}
const stops = (events: ScheduledEvent[]) => events.filter((e) => e.category !== 'transport');
const span = (e: ScheduledEvent): [number, number] => {
  const s = toMin(e.startTime);
  const end = toMin(e.endTime);
  return [s, end < s ? 24 * 60 : end];
};
const describeDay = (day: Day) => `${day.date} ${day.city.name}: ${day.events.map((e) => `${e.title} ${e.startTime}-${e.endTime}`).join(' | ')}`;

/** Everything the owner checks on every day of the Schedule. */
function expectScheduleSound(trip: Trip) {
  const days = scheduleDays(trip);
  for (const day of days) {
    const where = describeDay(day);
    const travel = day.events.filter((e) => e.category === 'transport');
    // Nothing overlaps a travel block or another stop.
    for (const s of stops(day.events)) {
      for (const other of day.events) {
        if (other === s) continue;
        const [a0, a1] = span(s);
        const [b0, b1] = other.category === 'transport' && /^(Flight|Train|Bus)\s/.test(other.title) && toMin(other.endTime) < toMin(other.startTime)
          ? [toMin(other.startTime), toMin(other.startTime) + 60] // a same-day hop into an earlier time zone
          : span(other);
        expect({ where, overlap: a0 < b1 && b0 < a1 ? `${s.title} × ${other.title}` : null }).toEqual({ where, overlap: null });
      }
    }
    // Travel blocks name both ends.
    for (const e of travel) expect({ where, title: e.title }).toEqual({ where, title: expect.not.stringMatching(/the airport|the station/i) });
    // Arrival: nothing before landing + 1h, and the travel blocks are there.
    if (day.city.dates.arrival === day.date && day.index > 0) {
      const leg = day.city.transportIn;
      for (const s of stops(day.events)) expect({ where, ok: toMin(s.startTime) >= toMin(leg.arriveTime!) + 60 }).toEqual({ where, ok: true });
      expect({ where, flight: travel.some((e) => /^Flight .+ → .+$/.test(e.title) && e.startTime === leg.departTime) }).toEqual({ where, flight: true });
      expect({ where, head: travel.some((e) => /^Head to /.test(e.title) && e.endTime === leg.departTime) }).toEqual({ where, head: true });
    }
    // A full day in a city is planned, not empty.
    const isMiddle = day.date !== day.city.dates.arrival && day.date !== day.city.dates.departure;
    if (isMiddle) expect({ where, planned: stops(day.events).length > 0 }).toEqual({ where, planned: true });
  }
  // The flight home, on the last day, at its time, with nothing over the trip to the airport.
  const last = days[days.length - 1];
  const ret = trip.origin!.returnLeg!;
  const where = describeDay(last);
  expect({ where, date: ret.departDate }).toEqual({ where, date: last.date });
  const flight = last.events.find((e) => e.title === `Flight ${ret.originAirport} → ${ret.destAirport}`);
  expect({ where, flight: flight && `${flight.startTime}-${flight.endTime}` }).toEqual({ where, flight: `${ret.departTime}-${ret.arriveTime}` });
  const head = last.events.find((e) => e.title === `Head to ${ret.originAirport}`);
  expect({ where, head: head?.endTime }).toEqual({ where, head: ret.departTime });
  for (const s of stops(last.events)) expect({ where, ok: span(s)[1] <= toMin(head!.startTime) }).toEqual({ where, ok: true });
}

const current = () => useTripStore.getState().currentTrip!;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

describe('the Schedule after edits to the owner’s trip', () => {
  it('+1 night in the first city: the next city starts after its flight lands, the last day flies home, no day is left empty', async () => {
    useTripStore.setState({ currentTrip: plannedTrip() });
    mockSearches();
    render(<ResultsPage />);
    await openTab('Schedule');
    expectScheduleSound(current());

    await acceptFromChat(parisOneMoreNight, 'Give Paris one more night');
    await openTab('Schedule');
    const t = current();
    expect(t.cities.map((c) => [c.name, c.dates.arrival, c.dates.departure])).toEqual([
      ['Paris', '2027-01-12', '2027-01-16'],
      ['London', '2027-01-16', '2027-01-18'],
    ]);
    expectScheduleSound(t);
    // The day Paris gained (Jan 15) is planned from Paris's own picks.
    const jan15 = stops(t.cities[0].schedule!['2027-01-15']).map((e) => e.title.replace(/ \(.*\)$/, ''));
    expect(jan15.length).toBeGreaterThan(0);
    for (const title of jan15) expect([...PARIS_ACTS, ...PARIS_MEALS].map((p) => p.name)).toContain(title);
    // London's stops from the day it lost (Jan 15) and the morning it can no
    // longer make (Jan 16) are on its other days or listed — none lost.
    const london = t.cities[1];
    const kept = [...Object.values(london.schedule!).flat().map((e) => e.title), ...(london.unscheduled ?? []).map((u) => u.title)];
    for (const e of Object.values(plannedTrip().cities[1].schedule!).flat()) {
      if (e.category !== 'transport') expect(kept.map((k) => k.replace(/ \(.*\)$/, ''))).toContain(e.title.replace(/ \(.*\)$/, ''));
    }
  });

  it('replace a city: the last day keeps the flight home, and the traveller’s own plans move to the new city', async () => {
    useTripStore.setState({ currentTrip: plannedTrip() });
    mockSearches();
    render(<ResultsPage />);
    await acceptFromChat(parisOneMoreNight, 'Give Paris one more night');
    // The traveller's own evening on London's middle day.
    act(() =>
      useTripStore.getState().addScheduledEvent(1, '2027-01-17', {
        id: 'mine', title: 'Dinner with Sam', startTime: '19:30', endTime: '21:00', category: 'custom',
      }),
    );
    await acceptFromChat(replaceLondon, 'Replace London with Edinburgh');
    await openTab('Schedule');
    const t = current();
    expect(t.cities.map((c) => c.name)).toEqual(['Paris', 'Edinburgh']);
    const lastDay = t.cities[1].schedule!['2027-01-18'];
    expect(lastDay.filter((e) => e.category === 'transport').map((e) => `${e.title} ${e.startTime}-${e.endTime}`)).toEqual([
      'Head to EDI 11:09-13:09',
      'Flight EDI → EWR 13:09-15:43',
    ]);
    // Their evening was on Jan 17; Edinburgh has Jan 17 now.
    expect(t.cities[1].schedule!['2027-01-17']).toContainEqual(expect.objectContaining({ id: 'mine', startTime: '19:30', endTime: '21:00' }));
    expect(t.cities[1].schedule!['2027-01-16'].filter((e) => e.category === 'transport').map((e) => e.title)).toEqual([
      'Head to PAR',
      'Flight PAR → EDI',
      'Arrive at EDI',
    ]);
    expectScheduleSound(t);
  });

  it('a later flight home, then +1 night: the flight home block moves to the new date and time', async () => {
    useTripStore.setState({ currentTrip: plannedTrip() });
    let landHomeFlight!: () => void;
    mockSearches({ homeFlightHeld: new Promise<void>((r) => (landHomeFlight = r)) });
    render(<ResultsPage />);
    await openTab('Schedule');
    await acceptFromChat(laterFlightHome, 'Change my flight home from London to a later one, in the evening');
    let t = current();
    expect(t.cities[1].schedule!['2027-01-17'].filter((e) => e.category === 'transport').map((e) => `${e.title} ${e.startTime}-${e.endTime}`)).toEqual([
      'Head to LON 19:25-21:25',
      'Flight LON → EWR 21:25-22:55',
    ]);
    // The day the evening flight frees up is planned, not left as two travel blocks.
    expect(stops(t.cities[1].schedule!['2027-01-17']).length).toBeGreaterThan(0);
    expectScheduleSound(t);

    // One more night in Paris from its card, with the Schedule open while
    // the flight home for the new last day is searched.
    await openTab('Flowchart');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('More nights in Paris'));
    });
    await openTab('Schedule');
    await act(async () => {
      landHomeFlight();
    });
    await waitFor(() => expect(current().origin?.returnLeg?.departDate).toBe('2027-01-18'));
    await waitFor(() => expect(current().cities[1].transportIn.departTime).toBe('11:36'));
    t = current();
    expect(t.cities[1].dates).toEqual({ arrival: '2027-01-16', departure: '2027-01-18' });
    // No trace of the old evening flight on Jan 17; the new one on Jan 18.
    expect(t.cities[1].schedule!['2027-01-17'].filter((e) => e.category === 'transport')).toEqual([]);
    expectScheduleSound(t);
  });

  it('a travel block names both airports', async () => {
    useTripStore.setState({ currentTrip: plannedTrip() });
    mockSearches();
    render(<ResultsPage />);
    await openTab('Schedule');
    const day = current().cities[1].schedule!['2027-01-15'].filter((e) => e.category === 'transport');
    expect(day.map((e) => `${e.title} ${e.startTime}-${e.endTime}`)).toEqual([
      'Head to PAR 08:50-10:50',
      'Arrive at LON 10:48-11:03',
      'Flight PAR → LON 10:50-10:48',
    ]);
    // The home flights keep theirs.
    expect(current().cities[0].schedule!['2027-01-12'].map((e) => e.title)).toEqual(['Head to EWR', 'Flight EWR → PAR', 'Arrive at PAR']);
    expect(current().cities[1].schedule!['2027-01-17'].filter((e) => e.category === 'transport').map((e) => e.title)).toEqual([
      'Head to LON',
      'Flight LON → JFK',
    ]);
  });

  it('the city card − / + nights: the same checks, both ways', async () => {
    useTripStore.setState({ currentTrip: plannedTrip() });
    mockSearches();
    render(<ResultsPage />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('More nights in Paris'));
    });
    await waitFor(() => expect(current().origin?.returnLeg?.departDate).toBe('2027-01-18'));
    await waitFor(() => expect(current().cities[1].transportIn.departTime).toBe('11:36'));
    await openTab('Schedule');
    let t = current();
    expect(t.cities.map((c) => [c.dates.arrival, c.dates.departure])).toEqual([
      ['2027-01-12', '2027-01-16'],
      ['2027-01-16', '2027-01-18'],
    ]);
    expectScheduleSound(t);

    await openTab('Flowchart');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Fewer nights in Paris'));
    });
    await waitFor(() => expect(current().origin?.returnLeg?.departDate).toBe('2027-01-17'));
    await waitFor(() => expect(current().cities[1].transportIn.departDate).toBe('2027-01-15'));
    await openTab('Schedule');
    t = current();
    expect(t.cities.map((c) => [c.dates.arrival, c.dates.departure])).toEqual([
      ['2027-01-12', '2027-01-15'],
      ['2027-01-15', '2027-01-17'],
    ]);
    expectScheduleSound(t);
    // Paris's lost day is gone from its schedule.
    expect(t.cities[0].schedule!['2027-01-15']).toBeUndefined();
  });
});
