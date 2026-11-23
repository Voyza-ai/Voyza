/**
 * An overnight leg says so under its box: "Overnight · lands Thu, Dec 24".
 * Before, a small "+1" after the arrival time was the only sign, so the first
 * city's stay starting a day after the trip (the night is on the plane) went
 * unexplained: Boston → Lisbon left Dec 23 at 17:01 and landed Dec 24 at 05:25.
 * The Back home card, which shows the arrival time, now shows the arrival day.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import Connector from '@/components/results/Connector';
import { HomeCard, homeArrivalDate } from '@/components/results/Flowchart';
import type { HomeLeg, Transport } from '@/lib/types';
import { buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';

beforeEach(() => {
  useTripStore.setState({ currentTrip: buildTrip() });
});

const props = { index: -1, cityIndex: -1, isExpanded: false, onToggle: jest.fn() };

const flight = (over: Partial<Transport>): Transport => ({
  mode: 'flight',
  operator: 'TAP Air Portugal',
  duration: '7h 24m',
  price: 406,
  from: 'Boston',
  to: 'Lisbon',
  departTime: '17:01',
  arriveTime: '05:25',
  departDate: '2026-12-23',
  ...over,
});

describe('the overnight tag under a leg box', () => {
  it('names the night and the day it lands (Boston → Lisbon, Dec 23 17:01 → Dec 24 05:25)', () => {
    render(<Connector transport={flight({})} {...props} />);
    expect(screen.getByTestId('overnight-tag')).toHaveTextContent('Overnight · lands Thu, Dec 24');
    // The "+1" stays on the arrival time.
    expect(screen.getByText('05:25 +1')).toBeInTheDocument();
  });

  it('shows on the flight home too, and on a night train between cities (date from the leg)', () => {
    const { unmount } = render(
      <Connector transport={flight({ from: 'Lisbon', to: 'Boston', departTime: '22:10', arriveTime: '06:40', duration: '13h 30m', departDate: '2026-12-27' })} {...props} />,
    );
    expect(screen.getByTestId('overnight-tag')).toHaveTextContent('lands Mon, Dec 28');
    unmount();
    render(
      <Connector
        transport={{ mode: 'train', operator: 'ÖBB Nightjet', duration: '11h', price: 120, departTime: '21:40', arriveTime: '08:40' }}
        legDate="2026-12-25"
        {...props}
        cityIndex={0}
        index={0}
      />,
    );
    expect(screen.getByTestId('overnight-tag')).toHaveTextContent('Overnight · lands Sat, Dec 26');
  });

  it('is absent on a same-day leg, a time-zone hop that only looks earlier, or a leg with no date', () => {
    const { rerender } = render(<Connector transport={flight({ departTime: '09:15', arriveTime: '11:30', duration: '2h 15m' })} {...props} />);
    expect(screen.queryByTestId('overnight-tag')).toBeNull();
    // Paris 10:50 → London 10:48: earlier on the clock, same day.
    rerender(<Connector transport={flight({ departTime: '10:50', arriveTime: '10:48', duration: '1h 0m' })} {...props} />);
    expect(screen.queryByTestId('overnight-tag')).toBeNull();
    rerender(<Connector transport={flight({ departDate: undefined })} {...props} />);
    expect(screen.queryByTestId('overnight-tag')).toBeNull();
  });

  it('keeps every box the same size: the tag sits outside the layout', () => {
    render(<Connector transport={flight({})} {...props} />);
    expect(screen.getByTestId('overnight-tag').className).toMatch(/\babsolute\b/);
  });
});


const back = (over: Partial<HomeLeg>): HomeLeg =>
  ({
    originAirport: 'VIE',
    destAirport: 'JFK',
    price: 516,
    currency: 'USD',
    durationMinutes: 870,
    operator: 'Austrian',
    departTime: '22:10',
    arriveTime: '06:40',
    departDate: '2026-12-27',
    stops: 0,
    ...over,
  }) as HomeLeg;

describe('the Back home card shows the day the flight lands', () => {
  it('an overnight flight home: Mon, Dec 28 next to Arrive 06:40 (was Sun, Dec 27)', () => {
    render(<HomeCard city="New York" airports={['JFK']} label="Back home" direction="inbound" leg={back({})} />);
    expect(screen.getByText('Mon, Dec 28')).toBeInTheDocument();
    expect(screen.queryByText('Sun, Dec 27')).toBeNull();
  });

  it('uses the flight’s own arrival date when it has one, and the departure day for a same-day flight', () => {
    expect(homeArrivalDate(back({ arriveDate: '2026-12-29' }))).toBe('2026-12-29');
    expect(homeArrivalDate(back({ departTime: '20:07', arriveTime: '23:46', durationMinutes: 579 }))).toBe('2026-12-27');
    expect(homeArrivalDate(back({}))).toBe('2026-12-28');
  });

  it('the outbound (Home) card still shows the day it leaves', () => {
    render(<HomeCard city="Boston" airports={['BOS']} label="Home" direction="outbound" leg={back({ originAirport: 'BOS', destAirport: 'LIS', departTime: '17:01', arriveTime: '05:25', durationMinutes: 444, departDate: '2026-12-23' })} />);
    expect(screen.getByText('Wed, Dec 23')).toBeInTheDocument();
  });
});
