/**
 * Owner feedback round (2026-11-03):
 *  - a dashed travel line between "Arrive at …" and the first stop, and
 *    between the last stop and "Head to the airport" (located hubs);
 *  - date of birth as Month / Day / Year selects.
 */
import './mocks';
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { dayConnectors } from '@/components/results/TravelConnectors';
import { estimateHubTravel } from '@/lib/geoSchedule';
import { legsForDay, type DayHubs } from '@/lib/tripHubs';
import DateSelect from '@/components/booking/DateSelect';
import type { ScheduledEvent } from '@/lib/types';
import { buildTrip } from './fixtures';

const FCO = { kind: 'airport' as const, name: 'Fiumicino', code: 'FCO', lat: 41.8045, lng: 12.252, approximate: false };
const COLOSSEUM = { lat: 41.8902, lng: 12.4922, placeId: 'osm:colosseum' };

const ev = (over: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: Math.random().toString(36).slice(2),
  title: 'x',
  startTime: '10:00',
  endTime: '11:00',
  ...over,
});

describe('travel line to and from the airport', () => {
  const arrive = ev({ id: 'arr', title: 'Arrive at Rome', category: 'transport', startTime: '18:35', endTime: '18:50' });
  const forum = ev({ id: 'forum', title: 'Colosseum and Roman Forum', category: 'activity', startTime: '19:35', endTime: '22:35', ...COLOSSEUM });

  it('draws Arrive at → first located stop once the arrival airport is known', () => {
    const hubs: DayHubs = { arrive: FCO, departs: [] };
    const [c] = dayConnectors([arrive, forum], hubs);
    expect(c).toMatchObject({ key: 'arr>forum', startMin: 18 * 60 + 50, endMin: 19 * 60 + 35 });
    expect(c.leg.mode).toBe('transit');
    // ~22 km: an airport transfer, not two hours of city transit.
    expect(c.leg.minutes).toBeGreaterThanOrEqual(45);
    expect(c.leg.minutes).toBeLessThanOrEqual(75);
  });

  it('draws nothing from Arrive at while the airport is not located (as before)', () => {
    expect(dayConnectors([arrive, forum])).toHaveLength(0);
  });

  it('draws the last stop → Head to the airport, matched by departure time', () => {
    const lunch = ev({ id: 'lunch', category: 'restaurant', startTime: '12:00', endTime: '13:00', ...COLOSSEUM });
    const head = ev({ id: 'head', title: 'Head to FCO', category: 'transport', startTime: '14:30', endTime: '16:30' });
    const other = { ...FCO, code: 'CIA', lat: 41.7994, lng: 12.5949 };
    const hubs: DayHubs = { arrive: null, departs: [{ departTime: '09:00', hub: other }, { departTime: '16:30', hub: FCO }] };
    const [c] = dayConnectors([lunch, head], hubs);
    expect(c.key).toBe('lunch>head');
    expect(c.leg).toEqual(estimateHubTravel(FCO, COLOSSEUM));
  });

  it('never connects two transport blocks', () => {
    const flight = ev({ id: 'f', title: 'Flight CDG → Rome', category: 'transport', startTime: '16:30', endTime: '18:35' });
    expect(dayConnectors([flight, arrive], { arrive: FCO, departs: [{ hub: FCO }] })).toHaveLength(0);
  });

  it('a station hub uses the ordinary city estimate', () => {
    const station = { ...FCO, kind: 'station' as const, lat: 41.9009, lng: 12.5013 };
    expect(estimateHubTravel(station, COLOSSEUM).minutes).toBeLessThanOrEqual(25);
  });
});

describe('legsForDay', () => {
  it('finds the inter-city leg into a city and the home leg out of the last one', () => {
    const trip = buildTrip();
    const last = trip.cities.length - 1;
    const city = trip.cities[last];
    const inbound = legsForDay(trip, last, city.dates.arrival).inbound;
    if (city.transportIn?.arriveTime && last > 0) {
      expect(inbound?.to).toMatchObject({ city: city.name, mode: city.transportIn.mode });
      expect(inbound?.from).toMatchObject({ city: trip.cities[last - 1].name });
    }
    expect(legsForDay(trip, 99, '2026-01-01')).toEqual({ inbound: null, outbound: null });
  });
});

describe('DateSelect (date of birth)', () => {
  function Harness({ onIso }: { onIso: (v: string) => void }) {
    const [v, setV] = useState('');
    return (
      <DateSelect
        id="dob"
        label="Date of birth"
        className=""
        value={v}
        fromYear={2026}
        toYear={1916}
        onChange={(iso) => {
          setV(iso);
          onIso(iso);
        }}
      />
    );
  }

  it('emits YYYY-MM-DD only once month, day and year are all picked', () => {
    const seen: string[] = [];
    render(<Harness onIso={(v) => seen.push(v)} />);
    fireEvent.change(screen.getByLabelText('Date of birth month'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Date of birth day'), { target: { value: '9' } });
    expect(seen[seen.length - 1]).toBe('');
    fireEvent.change(screen.getByLabelText('Date of birth year'), { target: { value: '1995' } });
    expect(seen[seen.length - 1]).toBe('1995-04-09');
  });

  it('lists years newest first and drops a day the month does not have', () => {
    const seen: string[] = [];
    render(<Harness onIso={(v) => seen.push(v)} />);
    const years = screen.getByLabelText('Date of birth year') as HTMLSelectElement;
    expect(years.options[1].value).toBe('2026');
    expect(years.options[years.options.length - 1].value).toBe('1916');
    fireEvent.change(screen.getByLabelText('Date of birth month'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Date of birth day'), { target: { value: '31' } });
    fireEvent.change(years, { target: { value: '1990' } });
    expect(seen[seen.length - 1]).toBe('1990-01-31');
    fireEvent.change(screen.getByLabelText('Date of birth month'), { target: { value: '2' } }); // Feb 31
    expect(seen[seen.length - 1]).toBe('');
    expect((screen.getByLabelText('Date of birth day') as HTMLSelectElement).options).toHaveLength(29); // "Day" + 28
  });
});
