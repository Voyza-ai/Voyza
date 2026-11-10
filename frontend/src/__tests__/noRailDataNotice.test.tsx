/**
 * ROADMAP bug: legs in regions we have no train data for (US, Canada,
 * Australia, Africa, South America) showed flights only, silently. They now
 * say so: on the leg's pill and card, and once for the trip.
 */
import './mocks';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Connector from '@/components/results/Connector';
import NoRailDataNotice from '@/components/results/NoRailDataNotice';
import { legNoRailRegion, noRailRegion, tripNoRailRegions, joinRegions } from '@/lib/railCoverage';
import type { City, Transport } from '@/lib/types';

const flight: Transport = {
  mode: 'flight',
  operator: 'Duffel Airways',
  duration: '1h 20m',
  price: 180,
  departTime: '09:00',
  arriveTime: '10:20',
};
const train: Transport = { ...flight, mode: 'train', operator: 'Trenitalia' };

const city = (name: string, country: string, transportOut: Transport = flight): City =>
  ({ name, country, transportOut, transportIn: flight, dates: { arrival: '2027-03-01', departure: '2027-03-03' } } as unknown as City);

describe('railCoverage', () => {
  it('names the region for uncovered countries and nothing for covered ones', () => {
    expect(noRailRegion('United States')).toBe('the US');
    expect(noRailRegion('USA')).toBe('the US');
    expect(noRailRegion('Canada')).toBe('Canada');
    expect(noRailRegion('Australia')).toBe('Australia');
    expect(noRailRegion('Kenya')).toBe('Africa');
    expect(noRailRegion('Brazil')).toBe('South America');
    expect(noRailRegion('Italy')).toBeNull();
    expect(noRailRegion('Japan')).toBeNull();
    expect(noRailRegion('')).toBeNull();
  });

  it('flags a flight leg with either end uncovered, never a train leg', () => {
    expect(legNoRailRegion('United States', 'United States', flight)).toBe('the US');
    expect(legNoRailRegion('Italy', 'Brazil', flight)).toBe('South America');
    expect(legNoRailRegion('Italy', 'France', flight)).toBeNull();
    expect(legNoRailRegion('United States', 'Canada', train)).toBeNull();
    expect(legNoRailRegion('United States', 'Canada', { ...flight, alternatives: [train] })).toBeNull();
  });

  it('lists each region once across the trip, in route order', () => {
    const trip = { cities: [city('New York', 'United States'), city('Boston', 'United States'), city('Toronto', 'Canada'), city('Rome', 'Italy')] };
    expect(tripNoRailRegions(trip)).toEqual(['the US', 'Canada']);
    expect(joinRegions(['the US', 'Canada', 'Australia'])).toBe('the US, Canada and Australia');
    expect(tripNoRailRegions({ cities: [city('Rome', 'Italy'), city('Florence', 'Italy')] })).toEqual([]);
  });
});

describe('the notice on screen', () => {
  it('shows on the trip and can be dismissed', () => {
    render(<NoRailDataNotice trip={{ cities: [city('New York', 'United States'), city('Chicago', 'United States')] }} />);
    expect(screen.getByTestId('no-rail-notice').textContent).toContain("We don't have train data for the US yet");
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByTestId('no-rail-notice')).toBeNull();
  });

  it('is absent for a trip we have rail for', () => {
    render(<NoRailDataNotice trip={{ cities: [city('Rome', 'Italy'), city('Florence', 'Italy')] }} />);
    expect(screen.queryByTestId('no-rail-notice')).toBeNull();
  });

  it('marks the leg pill and its expanded card', () => {
    const { rerender } = render(
      <Connector transport={flight} index={0} cityIndex={0} isExpanded={false} onToggle={() => {}} noRailRegion="the US" />,
    );
    expect(screen.getByText('No train data')).toBeTruthy();
    rerender(<Connector transport={flight} index={0} cityIndex={0} isExpanded onToggle={() => {}} noRailRegion="the US" />);
    expect(screen.getByText(/We don't have train data for the US yet/)).toBeTruthy();
  });

  it('leaves a covered leg as it was', () => {
    render(<Connector transport={flight} index={0} cityIndex={0} isExpanded={false} onToggle={() => {}} />);
    expect(screen.getByText('Click for details')).toBeTruthy();
  });
});
