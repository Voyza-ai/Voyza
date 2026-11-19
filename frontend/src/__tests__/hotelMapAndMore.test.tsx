import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import { useTripStore } from '@/store/tripStore';
import { searchHotels } from '@/lib/api';
import { hotelWindow, newHotelsOnly, locateHotels, activitySpots, type HotelEntry } from '@/lib/hotelMap';
import { buildTrip, buildCity } from './fixtures';
import type { Hotel, ScheduledEvent, Trip } from '@/lib/types';

/**
 * The city guide's "Find more hotels" (once a greyed-out "Coming soon"), and
 * the hotel map that now sits beside the guide.
 */

// The map itself needs WebGL; here it is a stub that lists what it was given
// and offers the card's "Choose this hotel".
jest.mock('@/components/results/HotelMapPanel', () => ({
  __esModule: true,
  default: ({ entries, onSelect, selectedIndex }: any) => (
    <div data-testid="hotel-map-panel" data-selected={selectedIndex ?? ''}>
      {entries.map((e: any) => (
        <button key={e.index} type="button" onClick={() => onSelect(e.index)}>
          {`map: choose ${e.hotel.name}`}
        </button>
      ))}
    </div>
  ),
}));

const hotel = (n: number, extra: Partial<Hotel> = {}): Hotel => ({
  name: `Hotel ${n}`,
  rating: 8,
  pricePerNight: 100 + n,
  area: '',
  ...extra,
});
const hotels = (from: number, count: number) => Array.from({ length: count }, (_, i) => hotel(from + i));

const navProps = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };
const mockSearch = searchHotels as jest.Mock;

function tripWith(list: Hotel[], selected = 0): Trip {
  const trip = buildTrip();
  return { ...trip, cities: [buildCity({ hotels: list, hotel: list[selected], selectedHotelIndex: selected }), trip.cities[1]] };
}

/** The panel, re-rendered from the store on every change like the results page does. */
function Panel() {
  const trip = useTripStore((s) => s.currentTrip)!;
  return <CityDetailPanel trip={trip} cityIndex={0} {...navProps} />;
}

const listedHotelNames = () => {
  // HotelRow buttons are the ones carrying a per-night price.
  return screen
    .getAllByRole('button')
    .filter((b) => /\/night/.test(b.textContent ?? ''))
    // The name has its own element; the rating follows it with no space in
    // textContent ("Hotel 2" + "8" would read as "Hotel 28").
    .map((b) => b.querySelector('.font-medium')?.textContent ?? undefined);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch.mockResolvedValue([]);
});

describe('hotelWindow', () => {
  const city = { hotels: hotels(1, 10), selectedHotelIndex: 0, customHotel: undefined };

  it('lists the first four with nothing pinned', () => {
    expect(hotelWindow(city, 0).map((e) => [e.index, !!e.pinned])).toEqual([[0, false], [1, false], [2, false], [3, false]]);
  });

  it('a later set keeps the pick in view, ahead of four new hotels', () => {
    expect(hotelWindow(city, 4).map((e) => [e.index, !!e.pinned])).toEqual([[0, true], [4, false], [5, false], [6, false], [7, false]]);
  });

  it('does not pin the pick when the set already holds it, or when the stay is a custom hotel', () => {
    expect(hotelWindow({ ...city, selectedHotelIndex: 5 }, 4).some((e) => e.pinned)).toBe(false);
    expect(hotelWindow({ ...city, customHotel: { name: 'Airbnb', mode: 'perNight', amount: 90 } }, 4).some((e) => e.pinned)).toBe(false);
  });

  it('a short last set shows what is left', () => {
    expect(hotelWindow(city, 8).map((e) => e.index)).toEqual([0, 8, 9]);
  });
});

describe('newHotelsOnly', () => {
  it('drops hotels the city already lists, by name regardless of case and accents', () => {
    const existing = [hotel(1, { name: 'Hôtel Malte Opéra' }), hotel(2)];
    const fresh = [hotel(3, { name: 'hotel malte opera' }), hotel(2), hotel(4), hotel(4)];
    expect(newHotelsOnly(existing, fresh).map((h) => h.name)).toEqual(['Hotel 4']);
  });
});

describe('locateHotels', () => {
  const city = { name: 'Paris', country: 'France', dates: { arrival: '2027-01-12', departure: '2027-01-15' } };
  const centre = { lat: 48.8566, lon: 2.3522 };
  const entry = (h: Hotel, index: number): HotelEntry => ({ hotel: h, index });

  it('pins hotels that carry coordinates without asking anyone', async () => {
    const search = jest.fn();
    const lookup = jest.fn();
    const r = await locateHotels(city, 2, [entry(hotel(1, { lat: 48.87, lng: 2.33 }), 0)], {
      search,
      lookup,
      cityCentre: async () => centre,
    });
    expect(r.pins.map((p) => p.point)).toEqual([{ lat: 48.87, lon: 2.33 }]);
    expect(search).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a saved hotel without coordinates gets them from the same search, matched by name', async () => {
    const search = jest.fn().mockResolvedValue([{ name: 'HOTEL 1', lat: 48.86, lng: 2.34 }]);
    const lookup = jest.fn().mockResolvedValue(null);
    const r = await locateHotels(city, 3, [entry(hotel(1), 0), entry(hotel(2), 1)], { search, lookup, cityCentre: async () => centre });
    expect(search).toHaveBeenCalledWith({ city: 'Paris', checkin: '2027-01-12', checkout: '2027-01-15', adults: 3 });
    expect(r.pins.map((p) => [p.index, p.point])).toEqual([[0, { lat: 48.86, lon: 2.34 }]]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('Hotel 2', { name: 'Paris', country: 'France' }, centre);
    expect(r.unplaced.map((e) => e.index)).toEqual([1]);
  });

  it('a slow search does not hold the map: the name lookup goes on without it', async () => {
    jest.useFakeTimers();
    try {
      const search = jest.fn(() => new Promise<any[]>(() => {}));
      const lookup = jest.fn().mockResolvedValue({ lat: 48.86, lon: 2.34 });
      const p = locateHotels(city, 2, [entry(hotel(1), 0)], { search, lookup, cityCentre: async () => centre });
      await jest.advanceTimersByTimeAsync(4100);
      const r = await p;
      expect(r.pins.map((x) => x.point)).toEqual([{ lat: 48.86, lon: 2.34 }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a name lookup far from the city is left off', async () => {
    const r = await locateHotels(city, 2, [entry(hotel(1), 0), entry(hotel(3), 1)], {
      search: jest.fn().mockResolvedValue([]),
      lookup: jest.fn(async (name: string) => (name === 'Hotel 1' ? { lat: 48.88, lon: 2.32 } : { lat: 33.66, lon: -95.55 })),
      cityCentre: async () => centre,
    });
    expect(r.pins.map((p) => p.index)).toEqual([0]);
    expect(r.unplaced.map((e) => e.index)).toEqual([1]);
  });

  it('two hotels looked up onto the same building are both left off', async () => {
    const same = { lat: 51.5204, lon: -0.1651 };
    const r = await locateHotels(
      { ...city, name: 'London', country: 'United Kingdom' },
      2,
      [entry(hotel(1, { name: 'hub London - Marylebone' }), 0), entry(hotel(2, { name: 'hub London - Paddington' }), 1)],
      { search: jest.fn().mockResolvedValue([]), lookup: jest.fn().mockResolvedValue(same), cityCentre: async () => ({ lat: 51.5072, lon: -0.1276 }) },
    );
    expect(r.pins).toEqual([]);
    expect(r.unplaced).toHaveLength(2);
  });

  it('a looked-up hotel on the spot of one Booking placed is the one left off', async () => {
    const r = await locateHotels(
      city,
      2,
      [entry(hotel(1, { lat: 48.88, lng: 2.32 }), 0), entry(hotel(2), 1)],
      {
        search: jest.fn().mockResolvedValue([]),
        lookup: jest.fn().mockResolvedValue({ lat: 48.88, lon: 2.32 }),
        cityCentre: async () => centre,
      },
    );
    expect(r.pins.map((p) => p.index)).toEqual([0]);
    expect(r.unplaced.map((e) => e.index)).toEqual([1]);
  });

  it('with no city centre, frames on the hotels it has; with neither, places nothing', async () => {
    const some = await locateHotels(city, 2, [entry(hotel(1, { lat: 48.8, lng: 2.3 }), 0), entry(hotel(2, { lat: 48.9, lng: 2.4 }), 1)], {
      cityCentre: async () => null,
    });
    expect(some.centre!.lat).toBeCloseTo(48.85, 6);
    expect(some.centre!.lon).toBeCloseTo(2.35, 6);
    expect(some.pins).toHaveLength(2);
    const none = await locateHotels(city, 2, [entry(hotel(1), 0)], { cityCentre: async () => null });
    expect(none.centre).toBeNull();
    expect(none.unplaced).toHaveLength(1);
  });
});

describe('CityDetailPanel — Find more hotels', () => {
  it('the buttons are live, with no "Coming soon"', () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 10)), priceMode: 'total' });
    render(<Panel />);
    expect(screen.getByRole('button', { name: /Find more hotels/ })).toBeEnabled();
    // The map is beside the guide, not behind a button.
    expect(screen.queryByRole('button', { name: /Open map/ })).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByText('Randomize nearby')).toBeNull();
  });

  it('brings in the next four, keeping the pick in view and selected', () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 10)), priceMode: 'total' });
    render(<Panel />);
    expect(listedHotelNames()).toEqual(['Hotel 1', 'Hotel 2', 'Hotel 3', 'Hotel 4']);
    fireEvent.click(screen.getByRole('button', { name: /Find more hotels/ }));
    expect(listedHotelNames()).toEqual(['Hotel 1', 'Hotel 5', 'Hotel 6', 'Hotel 7', 'Hotel 8']);
    expect(screen.getByText('Your pick')).toBeInTheDocument();
    expect(screen.getByText('More hotels')).toBeInTheDocument();
    expect(useTripStore.getState().currentTrip!.cities[0].selectedHotelIndex).toBe(0);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('choosing from the new set makes it the stay', () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 10)), priceMode: 'total' });
    render(<Panel />);
    fireEvent.click(screen.getByRole('button', { name: /Find more hotels/ }));
    fireEvent.click(screen.getAllByRole('button').find((b) => /Hotel 6/.test(b.textContent ?? '') && /\/night/.test(b.textContent ?? ''))!);
    const c = useTripStore.getState().currentTrip!.cities[0];
    expect(c.selectedHotelIndex).toBe(5);
    expect(c.hotel.name).toBe('Hotel 6');
    // The new pick is in the set on screen, so nothing is pinned above it.
    expect(screen.queryByText('Your pick')).toBeNull();
  });

  it('once the trip’s own list runs short, asks the search for its next page and adds the new hotels', async () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 6)), priceMode: 'total' });
    mockSearch.mockResolvedValueOnce(
      [...hotels(3, 2), ...hotels(20, 5)].map((h) => ({ ...h, id: h.name, price: h.pricePerNight * 3, currency: 'USD', reviewCount: 10, stars: 3, thumbnail: '', bookingUrl: '', amenities: [] })),
    );
    render(<Panel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find more hotels/ }));
    });
    expect(mockSearch).toHaveBeenCalledWith({ city: 'Rome', checkin: '2026-06-15', checkout: '2026-06-18', adults: 2, page: 1 });
    const list = useTripStore.getState().currentTrip!.cities[0].hotels.map((h) => h.name);
    // Hotel 3 and 4 were already listed: only the five new ones are added.
    expect(list).toEqual(['Hotel 1', 'Hotel 2', 'Hotel 3', 'Hotel 4', 'Hotel 5', 'Hotel 6', 'Hotel 20', 'Hotel 21', 'Hotel 22', 'Hotel 23', 'Hotel 24']);
    await waitFor(() => expect(listedHotelNames()).toEqual(['Hotel 1', 'Hotel 5', 'Hotel 6', 'Hotel 20', 'Hotel 21']));
    expect(useTripStore.getState().currentTrip!.cities[0].selectedHotelIndex).toBe(0);
  });

  it('when the search has nothing new, goes back to the top picks and says so', async () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 4)), priceMode: 'total' });
    mockSearch.mockResolvedValueOnce(hotels(1, 4).map((h) => ({ ...h, id: h.name, price: 1, currency: 'USD', reviewCount: 1, stars: 3, thumbnail: '', bookingUrl: '', amenities: [] })));
    render(<Panel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find more hotels/ }));
    });
    expect(screen.getByText(/That's every hotel we found in Rome/)).toBeInTheDocument();
    expect(listedHotelNames()).toEqual(['Hotel 1', 'Hotel 2', 'Hotel 3', 'Hotel 4']);
    expect(useTripStore.getState().currentTrip!.cities[0].hotels).toHaveLength(4);
  });

  it('a failed search is treated as nothing new', async () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 4)), priceMode: 'total' });
    mockSearch.mockRejectedValueOnce(new Error('429'));
    render(<Panel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find more hotels/ }));
    });
    expect(screen.getByText(/That's every hotel we found in Rome/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find more hotels/ })).toBeEnabled();
  });
});

describe('CityDetailPanel — the map beside it', () => {
  const mapButtons = () =>
    Array.from(screen.getByTestId('hotel-map-panel').querySelectorAll('button')).map((b) => b.textContent);

  it('shows the hotels listed, follows a new set, and a pick made on it becomes the stay', async () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 10)), priceMode: 'total' });
    render(<Panel />);
    await screen.findByTestId('hotel-map-panel');
    expect(mapButtons()).toEqual(['map: choose Hotel 1', 'map: choose Hotel 2', 'map: choose Hotel 3', 'map: choose Hotel 4']);
    fireEvent.click(screen.getByRole('button', { name: /Find more hotels/ }));
    expect(mapButtons()).toEqual([
      'map: choose Hotel 1',
      'map: choose Hotel 5',
      'map: choose Hotel 6',
      'map: choose Hotel 7',
      'map: choose Hotel 8',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'map: choose Hotel 7' }));
    expect(useTripStore.getState().currentTrip!.cities[0].hotel.name).toBe('Hotel 7');
    // The pick moved out of the pinned row, but the map keeps its hotels
    // rather than being rebuilt under the traveller.
    expect(listedHotelNames()).toEqual(['Hotel 5', 'Hotel 6', 'Hotel 7', 'Hotel 8']);
    expect(mapButtons()).toContain('map: choose Hotel 1');
    // And it is told which one is now chosen, to open that hotel's card.
    expect(screen.getByTestId('hotel-map-panel').dataset.selected).toBe('6');
  });

  it('a pick made in the guide is passed to the map', async () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 10)), priceMode: 'total' });
    render(<Panel />);
    await screen.findByTestId('hotel-map-panel');
    fireEvent.click(screen.getAllByRole('button').find((b) => /Hotel 3/.test(b.textContent ?? '') && /\/night/.test(b.textContent ?? ''))!);
    expect(screen.getByTestId('hotel-map-panel').dataset.selected).toBe('2');
  });

  it('closing waits for the map and the guide to leave, then closes', async () => {
    useTripStore.setState({ currentTrip: tripWith(hotels(1, 10)), priceMode: 'total' });
    const onClose = jest.fn();
    const onCloseStart = jest.fn();
    render(<CityDetailPanel trip={useTripStore.getState().currentTrip!} cityIndex={0} onClose={onClose} onCloseStart={onCloseStart} onPrev={() => {}} onNext={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    // A second click while it is closing does nothing more.
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onCloseStart).toHaveBeenCalledTimes(1);
  });
});

describe('activitySpots', () => {
  const ev = (title: string, extra: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
    id: title,
    title,
    startTime: '10:00',
    endTime: '11:00',
    category: 'activity',
    lat: 51.5,
    lng: -0.1,
    ...extra,
  });

  it('takes located activities and meals once each, by name', () => {
    const spots = activitySpots({
      '2027-01-16': [ev('Tate Modern'), ev('Lunch', { category: 'restaurant', lat: 51.51 })],
      '2027-01-15': [ev('British Museum'), ev('british museum ', { lat: 51.52 })],
    });
    expect(spots.map((s) => `${s.name}:${s.kind}`)).toEqual(['British Museum:activity', 'Tate Modern:activity', 'Lunch:restaurant']);
  });

  it('leaves out transport, free time and anything without coordinates', () => {
    const spots = activitySpots({
      d: [ev('Flight', { category: 'transport' }), ev('Free', { category: 'free' }), ev('Somewhere', { lat: undefined }), ev('Custom', { category: 'custom' })],
    });
    expect(spots).toEqual([]);
    expect(activitySpots(undefined)).toEqual([]);
  });
});

import { parseLandmarks, landmarkQuery, fetchLandmarks } from '@/lib/landmarks';

describe('landmarks', () => {
  const row = (id: string, name: string, lon: number, lat: number, links: number) => ({
    item: { value: `http://www.wikidata.org/entity/${id}` },
    itemLabel: { value: name },
    coord: { value: `Point(${lon} ${lat})` },
    links: { value: String(links) },
  });

  it('reads the answer best-known first, one per item, skipping unlabelled ones', () => {
    const json = {
      results: {
        bindings: [
          row('Q19675', 'Louvre Museum', 2.3375, 48.861, 170),
          row('Q243', 'Eiffel Tower', 2.2945, 48.8584, 191),
          row('Q243', 'Eiffel Tower', 2.2945, 48.8584, 191),
          row('Q999', 'Q999', 2.3, 48.85, 90),
          { ...row('Q1', 'Broken', 0, 0, 80), coord: { value: 'nonsense' } },
        ],
      },
    };
    expect(parseLandmarks(json)).toEqual([
      { id: 'Q243', name: 'Eiffel Tower', point: { lat: 48.8584, lon: 2.2945 }, sitelinks: 191 },
      { id: 'Q19675', name: 'Louvre Museum', point: { lat: 48.861, lon: 2.3375 }, sitelinks: 170 },
    ]);
  });

  it('keeps at most eight', () => {
    const json = { results: { bindings: Array.from({ length: 12 }, (_, i) => row(`Q${i + 1}`, `Place ${i + 1}`, 2.3, 48.85, 100 - i)) } };
    expect(parseLandmarks(json).map((l) => l.name)).toEqual(['Place 1', 'Place 2', 'Place 3', 'Place 4', 'Place 5', 'Place 6', 'Place 7', 'Place 8']);
  });

  it('asks around the centre, longitude first as WKT wants it', () => {
    const q = landmarkQuery({ lat: 48.8566, lon: 2.3522 });
    expect(q).toContain('Point(2.3522 48.8566)');
    expect(q).toContain('wdt:P1082'); // no cities or districts
    expect(q).toContain('wdt:P195'); // no artworks
  });

  it('a failed lookup is [] and is asked again next time; a good one is cached', async () => {
    window.localStorage.clear();
    const centre = { lat: 51.5072, lon: -0.1276 };
    const fail = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    expect(await fetchLandmarks(centre, fail as any)).toEqual([]);
    const ok = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: { bindings: [row('Q41225', 'Big Ben', -0.1246, 51.5007, 88)] } }) });
    expect((await fetchLandmarks(centre, ok as any)).map((l) => l.name)).toEqual(['Big Ben']);
    const again = jest.fn();
    expect((await fetchLandmarks(centre, again as any)).map((l) => l.name)).toEqual(['Big Ben']);
    expect(again).not.toHaveBeenCalled();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('a thrown fetch (offline, timeout) is []', async () => {
    window.localStorage.clear();
    const boom = jest.fn().mockRejectedValue(new Error('network'));
    expect(await fetchLandmarks({ lat: 1, lon: 2 }, boom as any)).toEqual([]);
  });
});

import { sameHotelName, lookupHotelByName } from '@/lib/hotelMap';
import { retryWaitMs } from '@/lib/landmarks';

describe('sameHotelName — measured on the Paris and London lists', () => {
  const paris = { name: 'Paris', country: 'France' };
  const london = { name: 'London', country: 'United Kingdom' };
  it.each([
    ['Ibis Styles Paris Batignolles', 'ibis Styles Paris Batignolles', paris],
    ['Novotel Paris 14 Porte d’Orléans', 'Hôtel Novotel Paris Porte d’Orléans', paris],
    ["Novotel Paris 14 Porte d'Orléans", "Hôtel Novotel Paris Porte d'Orléans", paris],
    ['Ibis Paris Gare Montparnasse Catalogne', 'ibis Montparnasse Catalogne', paris],
    ['Hotel Abbatial Saint Germain', 'Hôtel abbatial Saint-Germain', paris],
    ['Hilton Paris Opera', 'Hilton Paris Opera', paris],
    ['The Buxton', 'The Buxton', london],
    ['Radisson Blu Hotel, London Bloomsbury', 'Radisson Blu Hotel London Bloomsbury', london],
  ])('%s is %s', (booking, found, place) => {
    expect(sameHotelName(booking, found, place)).toBe(true);
  });
  it.each([
    ['Hotel Monterosa - Astotel', 'Hôtel Bradford Elysées - Astotel', paris],
    ['Pullman Paris Tour Eiffel', 'Ibis Paris Tour Eiffel Cambronne 15ème', paris],
    ['Novotel London Bridge', 'Novotel London Tower Bridge', london],
    ['Novotel London Bridge', 'Novotel London City South', london],
    ['hub London - Paddington', 'hub', london],
    ['The Belgrave London Victoria', 'The Victoria Inn London', london],
    ['Courtyard by Marriott Paris Gare de Lyon', 'Courtyard by Marriott Paris Creteil', paris],
    ['Aparthotel Adagio London City East', 'Aparthotel Adagio London Stratford', london],
  ])('%s is not %s', (booking, found, place) => {
    expect(sameHotelName(booking, found, place)).toBe(false);
  });
});

describe('lookupHotelByName', () => {
  const paris = { name: 'Paris', country: 'France' };
  const centre = { lat: 48.8566, lon: 2.3522 };
  const photon = (features: any[]) => ({ ok: true, status: 200, json: async () => ({ features }) });
  const feature = (name: string, lat: number, lon: number, kind = 'hotel') => ({
    properties: { name, osm_key: 'tourism', osm_value: kind },
    geometry: { coordinates: [lon, lat] },
  });
  beforeEach(() => window.localStorage.clear());

  it('takes the lodging whose name is the hotel’s, asked near the city and limited to tourism places', async () => {
    const f = jest.fn().mockResolvedValue(
      photon([
        feature('Hôtel Bradford Elysées - Astotel', 48.8729, 2.3081),
        feature('Ibis Paris Tour Eiffel', 48.847, 2.3013),
        feature('Hôtel Novotel Paris Porte d’Orléans', 48.8195, 2.3261),
      ]),
    );
    expect(await lookupHotelByName('Novotel Paris 14 Porte d’Orléans', paris, centre, f as any)).toEqual({ lat: 48.8195, lon: 2.3261 });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('photon.komoot.io');
    expect(url).toContain('osm_tag=tourism');
    expect(url).toContain('lat=48.8566');
  });

  it('a museum or a namesake in another city is not a pin', async () => {
    const f = jest.fn().mockResolvedValue(photon([feature('Hilton Paris Opera', 48.8757, 2.3259, 'museum'), feature('Hilton Paris Opera', 33.66, -95.55)]));
    expect(await lookupHotelByName('Hilton Paris Opera', paris, centre, f as any)).toBeNull();
  });

  it('when Photon is down, asks Nominatim, held to the same name check', async () => {
    const f = jest.fn(async (url: string) =>
      url.includes('photon')
        ? { ok: false, status: 503, json: async () => ({}) }
        : {
            ok: true,
            status: 200,
            json: async () => [
              { name: 'The Plumbers Arms', category: 'amenity', type: 'pub', lat: '48.85', lon: '2.35' },
              { name: 'Hilton Paris Opera', category: 'tourism', type: 'hotel', lat: '48.8757', lon: '2.3259' },
            ],
          },
    );
    expect(await lookupHotelByName('Hilton Paris Opera', paris, centre, f as any)).toEqual({ lat: 48.8757, lon: 2.3259 });
    expect(f.mock.calls.map((c) => String(c[0]).includes('nominatim'))).toEqual([false, true]);
  });

  it('answers are kept, a failed lookup is not', async () => {
    const down = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await lookupHotelByName('Hilton Paris Opera', paris, centre, down as any)).toBeNull();
    const up = jest.fn().mockResolvedValue(photon([feature('Hilton Paris Opera', 48.8757, 2.3259)]));
    expect(await lookupHotelByName('Hilton Paris Opera', paris, centre, up as any)).toEqual({ lat: 48.8757, lon: 2.3259 });
    const again = jest.fn();
    expect(await lookupHotelByName('Hilton Paris Opera', paris, centre, again as any)).toEqual({ lat: 48.8757, lon: 2.3259 });
    expect(again).not.toHaveBeenCalled();
  });
});

describe('landmarks: a refusal is retried once', () => {
  beforeEach(() => window.localStorage.clear());

  it('Retry-After is honoured, capped at 8 s', () => {
    expect(retryWaitMs('3')).toBe(3000);
    expect(retryWaitMs('120')).toBe(8000);
    expect(retryWaitMs(null)).toBe(2000);
    expect(retryWaitMs('garbage')).toBe(2000);
  });

  it('a 429 then an answer gives the landmarks', async () => {
    jest.useFakeTimers();
    try {
      const body = { results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q243' }, itemLabel: { value: 'Eiffel Tower' }, coord: { value: 'Point(2.2945 48.8584)' }, links: { value: '191' } }] } };
      const f = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '1' } })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
      const p = fetchLandmarks({ lat: 48.86, lon: 2.35 }, f as any);
      await jest.advanceTimersByTimeAsync(1100);
      expect((await p).map((l) => l.name)).toEqual(['Eiffel Tower']);
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
