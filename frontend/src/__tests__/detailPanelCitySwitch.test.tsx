import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import ActivitiesDetailPanel from '@/components/results/ActivitiesDetailPanel';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';
import { CustomHotel, Restaurant, Trip } from '@/lib/types';

/**
 * Regression guard for the detail panels keeping the previous city's form
 * state. results/page.tsx swaps `cityIndex` and leaves the panel mounted, so
 * any child that seeds local state from props — or holds an index into the
 * city's own arrays — has to be remounted per city with `key={cityIndex}`.
 * Without that key the form shows city A's values while Cancel, "Use this
 * stay" and the inline edits all write to city B.
 */

const navProps = {
  onClose: jest.fn(),
  onPrev: jest.fn(),
  onNext: jest.fn(),
};

const romeStay: CustomHotel = { name: 'Airbnb in Trastevere', mode: 'perNight', amount: 120 };
const florenceStay: CustomHotel = { name: 'Loft near the Duomo', mode: 'total', amount: 400 };

/** The fixture trip is [Rome, Florence] — attach a custom stay to either. */
function tripWithStays(rome?: CustomHotel, florence?: CustomHotel): Trip {
  const trip = buildTrip();
  return {
    ...trip,
    cities: [
      { ...trip.cities[0], customHotel: rome },
      { ...trip.cities[1], customHotel: florence },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip(), priceMode: 'total' });
});

describe('CityDetailPanel custom-stay form across city switches', () => {
  it("shows the new city's saved stay, not the previous city's", () => {
    const trip = tripWithStays(romeStay, florenceStay);
    useTripStore.setState({ currentTrip: trip });

    const { rerender } = render(<CityDetailPanel trip={trip} cityIndex={0} {...navProps} />);
    expect(screen.getByDisplayValue('Airbnb in Trastevere')).toBeInTheDocument();

    rerender(<CityDetailPanel trip={trip} cityIndex={1} {...navProps} />);

    expect(screen.getByDisplayValue('Loft near the Duomo')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Airbnb in Trastevere')).toBeNull();
  });

  it('collapses the form when the new city has no saved stay', () => {
    const trip = tripWithStays(romeStay, undefined);
    useTripStore.setState({ currentTrip: trip });

    const { rerender } = render(<CityDetailPanel trip={trip} cityIndex={0} {...navProps} />);
    expect(screen.getByDisplayValue('Airbnb in Trastevere')).toBeInTheDocument();

    rerender(<CityDetailPanel trip={trip} cityIndex={1} {...navProps} />);

    // Florence has no custom stay: the collapsed prompt, not Rome's values
    // sitting in an open form the user reads as leftover input.
    expect(screen.getByText('Use my own hotel or Airbnb')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Airbnb in Trastevere')).toBeNull();
  });

  it("opens the form on the new city's saved stay when the previous city had none", () => {
    const trip = tripWithStays(undefined, florenceStay);
    useTripStore.setState({ currentTrip: trip });

    const { rerender } = render(<CityDetailPanel trip={trip} cityIndex={0} {...navProps} />);
    expect(screen.getByText('Use my own hotel or Airbnb')).toBeInTheDocument();

    rerender(<CityDetailPanel trip={trip} cityIndex={1} {...navProps} />);

    // The other direction of the same bug: without a remount Florence's saved
    // stay stays invisible and un-editable even though the header's stay total
    // (effectiveHotel) already counts it.
    expect(screen.getByDisplayValue('Loft near the Duomo')).toBeInTheDocument();
  });

  it('Cancel clears the stay belonging to the city on screen', () => {
    const trip = tripWithStays(romeStay, florenceStay);
    useTripStore.setState({ currentTrip: trip });

    const { rerender } = render(<CityDetailPanel trip={trip} cityIndex={0} {...navProps} />);
    rerender(<CityDetailPanel trip={trip} cityIndex={1} {...navProps} />);

    fireEvent.click(screen.getByText('Cancel'));

    // The lever was always aimed here — the key is what lets the user see
    // whose stay they are cancelling before they pull it.
    const cities = useTripStore.getState().currentTrip!.cities;
    expect(cities[1].customHotel).toBeUndefined();
    expect(cities[0].customHotel?.name).toBe('Airbnb in Trastevere');
  });
});

describe('ActivitiesDetailPanel lists across city switches', () => {
  const florenceRestaurant: Restaurant = {
    name: 'Trattoria Mario',
    cuisine: 'Tuscan',
    priceRange: '$',
  };

  function tripWithFlorenceRestaurant(): Trip {
    const trip = buildTrip();
    return {
      ...trip,
      cities: [trip.cities[0], { ...trip.cities[1], restaurants: [florenceRestaurant] }],
    };
  }

  it("does not carry an open restaurant edit onto the next city's list", () => {
    const trip = tripWithFlorenceRestaurant();
    useTripStore.setState({ currentTrip: trip });

    const { rerender } = render(<ActivitiesDetailPanel trip={trip} cityIndex={0} {...navProps} />);

    // Rome's only restaurant, opened for inline editing. The name input has no
    // onBlur, so switching cities neither commits nor closes the edit.
    fireEvent.click(screen.getByText('Da Enzo'));
    expect(screen.getByDisplayValue('Da Enzo')).toBeInTheDocument();

    rerender(<ActivitiesDetailPanel trip={trip} cityIndex={1} {...navProps} />);

    // Florence's row 0 must render as text. Left as Rome's edit fields, its
    // next blur or Enter runs updateRestaurant(1, 0, …) with Rome's values.
    expect(screen.queryByDisplayValue('Da Enzo')).toBeNull();
    expect(screen.getByText('Trattoria Mario')).toBeInTheDocument();
  });

  it('does not carry an activity draft onto the next city', () => {
    const trip = buildTrip();
    useTripStore.setState({ currentTrip: trip });

    const { rerender } = render(<ActivitiesDetailPanel trip={trip} cityIndex={0} {...navProps} />);

    fireEvent.click(screen.getByText('Add activity'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Visit the Colosseum'), {
      target: { value: 'Trevi Fountain' },
    });

    rerender(<ActivitiesDetailPanel trip={trip} cityIndex={1} {...navProps} />);

    // Otherwise the draft is sitting in Florence's add form and Add runs
    // addActivity(1, 'Trevi Fountain').
    expect(screen.queryByDisplayValue('Trevi Fountain')).toBeNull();
    expect(screen.getByText('Add activity')).toBeInTheDocument();
  });
});
