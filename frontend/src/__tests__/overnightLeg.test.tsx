/**
 * An inter-city leg that arrives after midnight.
 *
 * Seen on a saved trip: Prague 16:36 → Budapest 00:29, travelling Jan 27.
 * The city guide said "ARRIVE 00:29 · Jan 27" (it is the 28th), the Calendar
 * cell read "16:36→00:29" as if it were one afternoon, and the day plan put
 * "Arrive at Budapest" at 00:29 at the top of the 27th and opened Budapest
 * activities from ~01:30 that morning — while the traveller was in Prague.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import CalendarView from '@/components/results/CalendarView';
import { arrivesNextDay, legArrivalDate } from '@/lib/cityLegs';
import { buildDayTransportContext } from '@/lib/dayScheduleDefaults';
import { legsForDay } from '@/lib/tripHubs';
import type { City, Transport, Trip } from '@/lib/types';

const placeholder: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const train = (from: string, to: string, dep: string, arr: string, duration: string, date: string): Transport => ({
  mode: 'train',
  operator: 'ČD',
  duration,
  price: 60,
  from,
  to,
  departTime: dep,
  arriveTime: arr,
  departDate: date,
  fromStation: `${from} hl.n.`,
  toStation: `${to}-Keleti`,
});

const city = (name: string, arrival: string, departure: string, i: number, tin: Transport, tout: Transport): City =>
  ({
    name,
    country: '',
    dates: { arrival, departure },
    transportIn: tin,
    transportOut: tout,
    hotel: { name: 'Hotel', rating: 4, pricePerNight: 100, area: '' },
    hotels: [{ name: 'Hotel', rating: 4, pricePerNight: 100, area: '' }],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
    colorIndex: i,
  }) as City;

const vp = train('Vienna', 'Prague', '05:10', '09:23', '4h 13m', '2027-01-25');
const pb = train('Prague', 'Budapest', '16:36', '00:29', '7h 53m', '2027-01-27');

const trip = (): Trip =>
  ({
    id: 't-overnight',
    title: 'Vienna · Prague · Budapest',
    status: 'planning',
    totalCost: 0,
    savings: 0,
    travelers: 2,
    cities: [
      city('Vienna', '2027-01-23', '2027-01-25', 0, placeholder, vp),
      city('Prague', '2027-01-25', '2027-01-27', 1, vp, pb),
      city('Budapest', '2027-01-27', '2027-01-30', 2, pb, placeholder),
    ],
    savingsTips: [],
  }) as unknown as Trip;

describe('arrivesNextDay / legArrivalDate', () => {
  it('a leg arriving at an earlier clock time than it left arrives tomorrow', () => {
    expect(arrivesNextDay(pb)).toBe(true);
    expect(legArrivalDate(pb, '2027-01-27')).toBe('2027-01-28');
  });

  it('a same-day leg arrives on its travel day', () => {
    expect(arrivesNextDay(vp)).toBe(false);
    expect(legArrivalDate(vp, '2027-01-25')).toBe('2027-01-25');
  });

  it('a short hop into an earlier time zone is the same day (Paris 10:50 → London 10:48)', () => {
    const hop = { departTime: '10:50', arriveTime: '10:48', duration: '58m' };
    expect(arrivesNextDay(hop)).toBe(false);
  });

  it('no duration: an earlier arrival clock is read as the next day', () => {
    expect(arrivesNextDay({ departTime: '22:10', arriveTime: '06:05', duration: '' })).toBe(true);
  });

  it('no duration: a short hop back in time is still the same day', () => {
    expect(arrivesNextDay({ departTime: '10:50', arriveTime: '10:48', duration: '' })).toBe(false);
    expect(arrivesNextDay({ departTime: '12:30', arriveTime: '10:00', duration: '' })).toBe(false);
  });

  it('crosses a month end', () => {
    expect(legArrivalDate(pb, '2027-01-31')).toBe('2027-02-01');
  });

  it('unknown times: travel day', () => {
    expect(arrivesNextDay({ departTime: undefined, arriveTime: '00:29', duration: '' })).toBe(false);
    expect(legArrivalDate({ ...pb, departTime: undefined }, '2027-01-27')).toBe('2027-01-27');
  });
});

describe('day plan around an overnight train', () => {
  const t = trip();
  const budapest = t.cities[2];

  it('travel day: head to the station and board, nothing in Budapest, no arrival marker', () => {
    const ctx = buildDayTransportContext(budapest, '2027-01-27', t, 2);
    expect(ctx.events.map((e) => e.title)).toEqual(['Head to Prague hl.n.', 'Train Prague hl.n. → Budapest-Keleti']);
    expect(ctx.windowStart).toBeGreaterThanOrEqual(ctx.windowEnd);
  });

  it('next day: the arrival marker at 00:29, then a normal day', () => {
    const ctx = buildDayTransportContext(budapest, '2027-01-28', t, 2);
    expect(ctx.events.map((e) => [e.title, e.startTime])).toEqual([['Arrive at Budapest-Keleti', '00:29']]);
    expect(ctx.windowStart).toBe(29 + 60);
    expect(ctx.windowEnd).toBe(24 * 60);
  });

  it('the day after that has no transport', () => {
    const ctx = buildDayTransportContext(budapest, '2027-01-29', t, 2);
    expect(ctx.events).toEqual([]);
  });

  it('a same-day leg is unchanged: head, train, arrive on the travel day; nothing the next', () => {
    const prague = t.cities[1];
    const day = buildDayTransportContext(prague, '2027-01-25', t, 1);
    expect(day.events.map((e) => e.title)).toEqual([
      'Head to Vienna hl.n.',
      'Train Vienna hl.n. → Prague-Keleti',
      'Arrive at Prague-Keleti',
    ]);
    expect(buildDayTransportContext(prague, '2027-01-26', t, 1).events).toEqual([]);
  });
});

describe('schedule connectors (tripHubs)', () => {
  it('travel day: leaves from Prague, no arrival hub; next day: arrives in Budapest', () => {
    const t = trip();
    const travel = legsForDay(t, 2, '2027-01-27');
    expect(travel.inbound?.from?.city).toBe('Prague');
    expect(travel.inbound?.to).toBeNull();
    const next = legsForDay(t, 2, '2027-01-28');
    expect(next.inbound?.to?.city).toBe('Budapest');
    expect(next.inbound?.from).toBeNull();
    expect(legsForDay(t, 2, '2027-01-29').inbound).toBeNull();
  });

  it('a same-day leg keeps both hubs on its travel day', () => {
    const day = legsForDay(trip(), 1, '2027-01-25');
    expect(day.inbound?.from?.city).toBe('Vienna');
    expect(day.inbound?.to?.city).toBe('Prague');
  });
});

describe('first city without a home flight (legacy trip)', () => {
  it('a red-eye into the first city keeps its arrival on the stay\'s first date', () => {
    const t = trip();
    const redEye: Transport = { ...placeholder, mode: 'flight', departTime: '19:25', arriveTime: '08:40', duration: '7h 15m' };
    t.cities[0] = { ...t.cities[0], transportIn: redEye };
    const ctx = buildDayTransportContext(t.cities[0], '2027-01-23', t, 0);
    expect(ctx.events.map((e) => e.title)).toContain('Arrive at VIE');
    expect(buildDayTransportContext(t.cities[0], '2027-01-24', t, 0).events).toEqual([]);
  });
});

describe('what the traveller reads', () => {
  const nav = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };

  it("the guide's ARRIVE is the 28th", () => {
    const tr = trip();
    useTripStore.setState({ currentTrip: tr, priceMode: 'total' });
    render(<CityDetailPanel trip={tr} cityIndex={2} {...nav} />);
    expect(screen.getByTestId('travel-dates').textContent).toContain('ArrJan 28·00:29');
  });

  it('a same-day arrival keeps its travel day', () => {
    const tr = trip();
    useTripStore.setState({ currentTrip: tr, priceMode: 'total' });
    render(<CityDetailPanel trip={tr} cityIndex={1} {...nav} />);
    expect(screen.getByTestId('travel-dates').textContent).toContain('ArrJan 25·09:23');
  });

  it('the Calendar marks the overnight leg +1 and leaves the same-day one alone', () => {
    const tr = trip();
    useTripStore.setState({ currentTrip: tr });
    render(<CalendarView trip={tr} />);
    expect(screen.getByText('16:36→00:29 +1')).toBeInTheDocument();
    expect(screen.getByText('05:10→09:23')).toBeInTheDocument();
  });
});
