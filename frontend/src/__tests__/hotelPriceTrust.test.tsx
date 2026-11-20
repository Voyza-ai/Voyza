/**
 * Hotel prices we cannot stand behind are said so, in two different words:
 *  - "looks off" (`priceSuspect`: out of line with its search), and
 *  - "unchecked" (`priceUnverified`: the search was too thin to compare —
 *    Val d'Isère returned one hotel at $3,377.84/night and it went into the
 *    trip total with nothing having looked at it).
 * Before this, both flags reached the trip and nothing rendered either.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import CityCard from '@/components/results/CityCard';
import ResultsHeader from '@/components/results/ResultsHeader';
import { hotelPriceTrust, tripPriceCaveats } from '@/lib/hotelPriceTrust';
import { hotelFromResult } from '@/lib/hotelShape';
import { liveTripTotal } from '@/lib/tripTotals';
import { buildCity, buildTrip, mockHotel, mockHotel2 } from './fixtures';
import type { Hotel, Trip } from '@/lib/types';

beforeAll(() => {
  let id = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++id);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

const valDisere: Hotel = { name: 'Le Refuge 2551', rating: 9.6, pricePerNight: 3377.84, area: '', reviewCount: 137, priceUnverified: true };
const glitch: Hotel = { name: 'Glitch Inn', rating: 8, pricePerNight: 9, area: '', priceSuspect: true, priceSuspectReason: 'below-tier-median' };

describe('hotelPriceTrust', () => {
  it('no flags: nothing to say', () => {
    expect(hotelPriceTrust(mockHotel)).toBeNull();
    expect(hotelPriceTrust(null)).toBeNull();
  });

  it('unverified: says we could not check, with the count', () => {
    const t = hotelPriceTrust(valDisere, { hotelsInSearch: 1 })!;
    expect(t.kind).toBe('unverified');
    expect(t.label).toBe('Price unchecked');
    expect(t.detail).toMatch(/Only one hotel came back/);
    expect(hotelPriceTrust(valDisere, { hotelsInSearch: 3 })!.detail).toMatch(/Only 3 hotels/);
  });

  it('suspect words follow the reason', () => {
    expect(hotelPriceTrust(glitch)!.label).toBe('Price looks low');
    expect(hotelPriceTrust({ priceSuspect: true, priceSuspectReason: 'above-tier-median' })!.label).toBe('Price looks high');
    expect(hotelPriceTrust({ priceSuspect: true, priceSuspectReason: 'above-star-ceiling' })!.label).toBe('Price looks high');
    expect(hotelPriceTrust({ priceSuspect: true, priceSuspectReason: 'occupancy-short' }, { travelers: 4 })!.detail).toMatch(/all 4 travelers/);
    // Legacy rows carry the flag without a reason.
    expect(hotelPriceTrust({ priceSuspect: true })!.label).toBe('Price looks off');
  });

  it('a suspect verdict wins over unverified', () => {
    expect(hotelPriceTrust({ priceSuspect: true, priceUnverified: true })!.kind).toBe('suspect');
  });
});

describe('hotelFromResult carries the flags', () => {
  const row = { id: 'x', name: 'A', price: 300, pricePerNight: 100, currency: 'USD', rating: 9, reviewCount: 10, stars: 4, thumbnail: '', bookingUrl: '', amenities: [] };
  it('copies priceUnverified and the suspect reason', () => {
    expect(hotelFromResult({ ...row, priceUnverified: true }).priceUnverified).toBe(true);
    expect(hotelFromResult({ ...row, priceSuspect: true, priceSuspectReason: 'above-tier-median' }).priceSuspectReason).toBe('above-tier-median');
  });
  it('a plain row maps to the same object as before', () => {
    const h = hotelFromResult(row);
    expect('priceUnverified' in h).toBe(false);
    expect('priceSuspectReason' in h).toBe(false);
  });
});

function tripWithHotels(hotels: Hotel[], selected = 0, extra: Partial<ReturnType<typeof buildCity>> = {}): Trip {
  const city = buildCity({ hotels, hotel: hotels[selected], selectedHotelIndex: selected, ...extra });
  const trip = buildTrip();
  return { ...trip, cities: [city, ...trip.cities.slice(1)] };
}

describe('the trip total', () => {
  it('keeps an unchecked price in the total and names it', () => {
    const trip = tripWithHotels([valDisere]);
    expect(tripPriceCaveats(trip)).toEqual({ suspect: [], unverified: ['Rome'] });
    const plain = tripWithHotels([{ ...valDisere, priceUnverified: undefined }]);
    expect(liveTripTotal(trip)).toBe(liveTripTotal(plain));
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByTestId('total-price-caveat')).toHaveTextContent('incl. 1 unchecked hotel price');
  });

  it('a hand-picked suspect hotel is named as looking off', () => {
    const trip = tripWithHotels([mockHotel, glitch], 1);
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByTestId('total-price-caveat')).toHaveTextContent('incl. a hotel price that looks off');
  });

  it('a suspect row in the list that is not selected adds nothing to the total line', () => {
    const trip = tripWithHotels([mockHotel, glitch], 0);
    render(<ResultsHeader trip={trip} />);
    expect(screen.queryByTestId('total-price-caveat')).toBeNull();
  });

  it("a traveller's own hotel is never flagged", () => {
    const trip = tripWithHotels([valDisere], 0, { customHotel: { name: 'Mine', mode: 'perNight', amount: 200 } });
    expect(tripPriceCaveats(trip)).toEqual({ suspect: [], unverified: [] });
  });
});

describe('what the traveller sees', () => {
  const nav = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };

  it('city guide: chip on the row, chip and explanation on the selected stay', () => {
    const trip = tripWithHotels([valDisere]);
    useTripStore.setState({ currentTrip: trip, priceMode: 'total' });
    render(<CityDetailPanel trip={trip} cityIndex={0} {...nav} />);
    expect(screen.getAllByTestId('price-trust-unverified')).toHaveLength(2);
    expect(screen.getByTestId('price-trust-note-unverified')).toHaveTextContent(/couldn't compare this price/);
  });

  it('city guide: a suspect row is marked in the list even when not selected', () => {
    const trip = tripWithHotels([mockHotel, mockHotel2, glitch], 0);
    useTripStore.setState({ currentTrip: trip, priceMode: 'total' });
    render(<CityDetailPanel trip={trip} cityIndex={0} {...nav} />);
    expect(screen.getAllByTestId('price-trust-suspect')).toHaveLength(1);
    expect(screen.queryByTestId('price-trust-note-suspect')).toBeNull();
  });

  it('city guide: an ordinary trip shows no caveat anywhere', () => {
    const trip = tripWithHotels([mockHotel, mockHotel2]);
    useTripStore.setState({ currentTrip: trip, priceMode: 'total' });
    render(<CityDetailPanel trip={trip} cityIndex={0} {...nav} />);
    expect(screen.queryByTestId(/price-trust/)).toBeNull();
  });

  it('flowchart card: chip on the stay', () => {
    const trip = tripWithHotels([valDisere]);
    useTripStore.setState({ currentTrip: trip });
    render(<CityCard city={trip.cities[0]} index={0} isActive={false} isDimmed={false} onHover={jest.fn()} onLeave={jest.fn()} onClick={jest.fn()} />);
    expect(screen.getByTestId('price-trust-unverified')).toHaveTextContent('Price unchecked');
  });
});
