import './mocks';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Flowchart from '@/components/results/Flowchart';
import ResultsPage from '@/app/results/page';
import {
  flowchartFilterCounts,
  parseFlowchartFilter,
  resetParkedShowParam,
} from '@/components/results/FlowchartFilter';
import { useTripStore } from '@/store/tripStore';
import type { HomeLeg, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

// MapLibre needs WebGL; the Map tab only has to mount.
jest.mock('@/components/results/MapView', () => ({
  __esModule: true,
  default: () => <div data-testid="map-view" />,
}));

/**
 * The flowchart's type filter (All · Travel · Hotels · Activities): the city
 * sequence and the route stay, only the cards change. Travel is compact —
 * every leg as its collapsed pill between the home and city nodes.
 */

const leg = (from: string, to: string, date: string): HomeLeg => ({
  originAirport: from,
  destAirport: to,
  price: 420,
  currency: 'USD',
  durationMinutes: 500,
  operator: 'Delta',
  carrierCode: 'DL',
  departTime: '18:00',
  arriveTime: '08:20',
  departDate: date,
  stops: 0,
  bookingUrl: null,
});

// New York → Rome (train) → Florence → New York. The Rome → Florence leg is
// a Trenitalia train (fixtures), so Travel is not just flights.
const trip: Trip = buildTrip({
  origin: {
    city: 'New York',
    airports: ['JFK'],
    outboundLeg: leg('JFK', 'FCO', '2026-06-14'),
    returnLeg: leg('FLR', 'JFK', '2026-06-20'),
  },
  returnToHome: true,
});

const chip = (id: string) => document.querySelector(`[data-filter-chip="${id}"]`) as HTMLElement;
const count = (sel: string) => document.querySelectorAll(sel).length;
const flowchartText = () => document.querySelector('[data-testid="flowchart"]')!.textContent;
const emptyNote = () => document.querySelector('[data-filter-empty]');

const scrollIntoView = jest.fn();
beforeAll(() => {
  (Element.prototype as any).scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  scrollIntoView.mockClear();
  resetParkedShowParam();
  window.history.replaceState(null, '', '/results');
  useTripStore.setState({ currentTrip: trip, tripPicks: null });
});

describe('flowchart type filter', () => {
  it('counts what each chip shows — Travel is every leg, home flights and trains included', () => {
    // 2 home flights + the Rome → Florence train; both stays; Rome 2 + 1, Florence 1 + 0.
    expect(flowchartFilterCounts(trip)).toEqual({ travel: 3, hotels: 2, activities: 4 });
    // One-way: no flight back home.
    expect(flowchartFilterCounts({ ...trip, returnToHome: false }).travel).toBe(2);
    // Every leg — one with no direct option, or a home flight still being
    // found, is still a leg of the journey (and Travel still shows its slot).
    const gaps: Trip = {
      ...trip,
      origin: { ...trip.origin!, returnLeg: undefined },
      cities: [{ ...trip.cities[0], transportOut: { ...trip.cities[0].transportOut, unavailable: true } }, trip.cities[1]],
    };
    expect(flowchartFilterCounts(gaps).travel).toBe(3);
    expect(parseFlowchartFilter('travel')).toBe('travel');
    expect(parseFlowchartFilter('hotels')).toBe('hotels');
    expect(parseFlowchartFilter('nonsense')).toBe('all');
    expect(parseFlowchartFilter(null)).toBe('all');
  });

  it('the chip is called Travel', () => {
    render(<Flowchart trip={trip} />);
    expect(chip('travel')).toHaveTextContent('Travel3');
    expect(chip('flights')).toBeNull();
    expect(screen.queryByText('Flights')).not.toBeInTheDocument();
  });

  it('All is the full flowchart', () => {
    render(<Flowchart trip={trip} />);
    expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Activities & Dining')).toHaveLength(2);
    expect(screen.getAllByText('Click for details')).toHaveLength(3);
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
    expect(screen.getByText('Depart')).toBeInTheDocument(); // full home card
    expect(count('[data-plain-route]')).toBe(0);
    expect(count('[data-compact-city]')).toBe(0);
    expect(emptyNote()).toBeNull();
  });

  it('Travel: every leg as its compact pill between compact home and city nodes', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('travel'));
    expect(chip('travel')).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.search).toBe('?show=travel');
    // Three collapsed pills (two home flights, the train) and none opened.
    expect(screen.getAllByLabelText('Show travel details')).toHaveLength(3);
    expect(screen.getAllByText('Click for details')).toHaveLength(3);
    expect(screen.queryByLabelText('Minimize')).not.toBeInTheDocument();
    // The narrow pill, not All's 200px one.
    const pills = screen.getAllByLabelText('Show travel details').map((b) => b.parentElement!.parentElement!);
    pills.forEach((p) => expect(p.className).toContain('w-[152px]'));
    // Home nodes keep the airport and the leg's date; cities are name + dates.
    expect(count('[data-compact-home]')).toBe(2);
    expect(screen.getByText('JFK · Jun 14')).toBeInTheDocument();
    expect(screen.getByText('JFK · Jun 20')).toBeInTheDocument();
    expect(count('[data-compact-city]')).toBe(2);
    expect(screen.getByText('3 nights')).toBeInTheDocument();
    // No hotels, no activities, no full home cards.
    expect(screen.queryByText('Hotel Roma Centro')).not.toBeInTheDocument();
    expect(screen.queryByText('Activities & Dining')).not.toBeInTheDocument();
    expect(screen.queryByText('Depart')).not.toBeInTheDocument();
    expect(count('[data-plain-route]')).toBe(0);
  });

  it('Travel: a leg opens on click, exactly as in All, and All keeps its own legs', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('travel'));
    // The second pill is the Rome → Florence train.
    fireEvent.click(screen.getAllByLabelText('Show travel details')[1]);
    expect(screen.getAllByLabelText('Minimize')).toHaveLength(1);
    expect(screen.getByText('Trenitalia')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Show travel details')).toHaveLength(2);
    // All was not touched by it…
    fireEvent.click(chip('all'));
    expect(screen.queryByLabelText('Minimize')).not.toBeInTheDocument();
    // …and Travel still has it open.
    fireEvent.click(chip('travel'));
    expect(screen.getAllByLabelText('Minimize')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Minimize'));
    expect(screen.queryByLabelText('Minimize')).not.toBeInTheDocument();
  });

  it('Travel: opening a leg that pushes the row past the edge brings up the scroll arrow', () => {
    jest.useFakeTimers();
    try {
      render(<Flowchart trip={trip} />);
      fireEvent.click(chip('travel'));
      act(() => jest.advanceTimersByTime(400));
      const scroller = document.querySelector('[data-testid="flowchart"] .overflow-x-auto') as HTMLElement;
      const size = (scrollWidth: number) => {
        Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: scrollWidth });
        Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1032 });
      };
      size(1000); // the compact journey fits
      fireEvent.scroll(scroller);
      expect(screen.queryByLabelText('Scroll right')).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByLabelText('Show travel details')[1]);
      size(1408); // the open card is 408px wider than its pill
      act(() => jest.advanceTimersByTime(400));
      expect(screen.getByLabelText('Scroll right')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Minimize'));
      size(1000);
      act(() => jest.advanceTimersByTime(400));
      expect(screen.queryByLabelText('Scroll right')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Hotels: stays only, legs as the bare dashed route', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('hotels'));
    expect(window.location.search).toBe('?show=hotels');
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
    expect(screen.getByText('Hotel Firenze')).toBeInTheDocument();
    expect(count('[data-plain-route]')).toBe(3);
    expect(screen.queryByText('Click for details')).not.toBeInTheDocument();
    expect(screen.queryByText('Depart')).not.toBeInTheDocument();
    expect(count('[data-compact-home]')).toBe(2);
    expect(screen.queryByText('Activities & Dining')).not.toBeInTheDocument();
    expect(emptyNote()).toBeNull();
  });

  it('Activities: the Activities & Dining cards, no hotels, bare route', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('activities'));
    expect(screen.getAllByText('Activities & Dining')).toHaveLength(2);
    expect(screen.getByText('Colosseum')).toBeInTheDocument();
    expect(count('[data-compact-city]')).toBe(2);
    expect(count('[data-plain-route]')).toBe(3);
    expect(screen.queryByText('Hotel Roma Centro')).not.toBeInTheDocument();
    expect(screen.queryByText('Click for details')).not.toBeInTheDocument();
    expect(emptyNote()).toBeNull();
  });

  it('back to All restores the flowchart, its open legs included', () => {
    render(<Flowchart trip={trip} />);
    // A leg the traveller opened in All stays open across the filters.
    fireEvent.click(screen.getAllByLabelText('Show travel details')[1]);
    const before = flowchartText();
    for (const f of ['travel', 'hotels', 'activities', 'all']) fireEvent.click(chip(f));
    expect(window.location.search).toBe('');
    expect(flowchartText()).toBe(before);
    expect(screen.getAllByLabelText('Minimize')).toHaveLength(1);
  });

  describe('a leg opened in All', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([['hotels'], ['travel'], ['activities']])(
      'is not scrolled back into view on returning from %s',
      (other) => {
        render(<Flowchart trip={trip} />);
        fireEvent.click(screen.getAllByLabelText('Show travel details')[2]);
        act(() => jest.advanceTimersByTime(400));
        // Opening it is what brings it into view (D-14)…
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        scrollIntoView.mockClear();
        fireEvent.click(chip(other));
        act(() => jest.advanceTimersByTime(400));
        fireEvent.click(chip('all'));
        act(() => jest.advanceTimersByTime(1000));
        // …coming back to All does not pull the row to it again.
        expect(screen.getAllByLabelText('Minimize')).toHaveLength(1);
        expect(scrollIntoView).not.toHaveBeenCalled();
      },
    );
  });

  describe('empty states', () => {
    it('Activities with none says so, quietly', () => {
      const bare = buildTrip({
        cities: [buildCity({ activities: [], restaurants: [] }), buildCity({ name: 'Florence', activities: [], restaurants: [] })],
      });
      useTripStore.setState({ currentTrip: bare });
      render(<Flowchart trip={bare} />);
      expect(chip('activities')).toHaveTextContent('Activities0');
      expect(emptyNote()).toBeNull(); // not under All
      fireEvent.click(chip('activities'));
      expect(screen.getByRole('status')).toHaveTextContent('No activities yet — ask BlueMurr AI to add some.');
      // The spine stays: the cities, the route.
      expect(count('[data-compact-city]')).toBe(2);
      fireEvent.click(chip('hotels'));
      expect(emptyNote()).toBeNull();
    });

    it('Hotels with none picked says so', () => {
      // The canvas's placeholder stay is not a stay (hasStay).
      const placeholder = { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' };
      const noStays = buildTrip({
        cities: [
          buildCity({ hotel: placeholder, hotels: [], selectedHotelIndex: 0 }),
          buildCity({ name: 'Florence', hotel: placeholder, hotels: [], selectedHotelIndex: 0 }),
        ],
      });
      useTripStore.setState({ currentTrip: noStays });
      render(<Flowchart trip={noStays} />);
      fireEvent.click(chip('hotels'));
      expect(screen.getByRole('status')).toHaveTextContent('No hotels picked yet — open a city to choose one.');
    });

    it('Travel with no legs (one city, no home) says so', () => {
      const single = buildTrip({ cities: [buildCity()] });
      useTripStore.setState({ currentTrip: single });
      render(<Flowchart trip={single} />);
      fireEvent.click(chip('travel'));
      expect(chip('travel')).toHaveTextContent('Travel0');
      expect(screen.getByRole('status')).toHaveTextContent('No travel legs on this trip.');
    });
  });

  it('Activities while the AI picks load: the loading cards stay, the note says they are coming', () => {
    const loadingTrip = buildTrip({
      picksRun: 'run-1',
      cities: [buildCity({ activities: [], restaurants: [] }), buildCity({ name: 'Florence', activities: [], restaurants: [] })],
    } as Partial<Trip>);
    useTripStore.setState({
      currentTrip: loadingTrip,
      tripPicks: {
        run: 'run-1',
        pending: [
          { city: 'Rome', travelers: 2, nights: 3 },
          { city: 'Florence', travelers: 2, nights: 2 },
        ],
        landed: {},
      } as any,
    });
    render(<Flowchart trip={loadingTrip} />);
    expect(screen.getAllByLabelText('Loading activities and dining')).toHaveLength(2);
    fireEvent.click(chip('activities'));
    expect(screen.getAllByLabelText('Loading activities and dining')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('BlueMurr AI is still picking activities…');
    // Travel hides them.
    fireEvent.click(chip('travel'));
    expect(screen.queryByLabelText('Loading activities and dining')).not.toBeInTheDocument();
  });

  describe('?show=', () => {
    it('opens on ?show=travel', () => {
      window.history.replaceState(null, '', '/results?show=travel');
      render(<Flowchart trip={trip} />);
      expect(chip('travel')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByLabelText('Show travel details')).toHaveLength(3);
      expect(count('[data-compact-city]')).toBe(2);
    });

    it('an old ?show=flights link opens Travel and the URL says travel', () => {
      window.history.replaceState(null, '', '/results?tripId=t1&show=flights');
      render(<Flowchart trip={trip} />);
      expect(chip('travel')).toHaveAttribute('aria-pressed', 'true');
      expect(window.location.search).toBe('?tripId=t1&show=travel');
    });

    it('is kept on the Flowchart tab only: dropped for Calendar, Schedule and Map, back on return', () => {
      render(<ResultsPage />);
      fireEvent.click(chip('travel'));
      expect(window.location.search).toBe('?show=travel');
      for (const tab of ['Calendar', 'Schedule', 'Map']) {
        fireEvent.click(screen.getByRole('button', { name: tab }));
        expect(window.location.search).toBe('');
        expect(document.querySelector('[data-testid="flowchart"]')).toBeNull();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Flowchart' }));
      expect(window.location.search).toBe('?show=travel');
      expect(chip('travel')).toHaveAttribute('aria-pressed', 'true');
      // All has no ?show= to park: the other tabs leave the URL alone.
      fireEvent.click(chip('all'));
      fireEvent.click(screen.getByRole('button', { name: 'Map' }));
      fireEvent.click(screen.getByRole('button', { name: 'Flowchart' }));
      expect(window.location.search).toBe('');
      expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
