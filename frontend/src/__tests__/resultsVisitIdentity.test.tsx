import './mocks';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildTrip, buildCity } from './fixtures';
import { searchHotels } from '@/lib/api';
import ResultsPage from '@/app/results/page';

/**
 * Two bugs with the same shape: something about a city was captured by its
 * POSITION or its NAME, and a repeat visit or a reorder made that wrong.
 * A visit's stable identity is name + arrival date.
 */

const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, priceMode: 'total' });
});

describe('hotel enrichment resolves the city by visit, not by index', () => {
  it('lands hotels on the right city after a reorder that happened mid-search', async () => {
    // Both cities have a single hotel, so both trigger a search.
    const rome = buildCity({ name: 'Rome' });
    const florence = buildCity({
      name: 'Florence',
      dates: { arrival: '2026-06-18', departure: '2026-06-20' },
    });
    rome.hotels = [rome.hotels[0]];
    florence.hotels = [florence.hotels[0]];
    const trip = buildTrip({ cities: [rome, florence] });
    useTripStore.setState({ currentTrip: trip });

    // Hold each city's search open so the store can change underneath it.
    const resolvers: Record<string, (v: any[]) => void> = {};
    mockedSearchHotels.mockImplementation(
      (params: any) => new Promise((resolve) => { resolvers[params.city] = resolve; }),
    );

    render(<ResultsPage />);
    await waitFor(() => expect(mockedSearchHotels).toHaveBeenCalledTimes(2));

    // The optimizer (or a drag) reorders the trip while the searches are out.
    act(() => {
      const t = useTripStore.getState().currentTrip!;
      useTripStore.setState({ currentTrip: { ...t, cities: [t.cities[1], t.cities[0]] } });
    });

    // Rome's search comes back. It was fired at index 0; Rome is now index 1.
    await act(async () => {
      resolvers['Rome']([
        { name: 'Rome Hotel A', rating: 4, pricePerNight: 100, bookingUrl: '' },
      ]);
    });

    const cities = useTripStore.getState().currentTrip!.cities;
    expect(cities[1].name).toBe('Rome');
    expect(cities[1].hotel.name).toBe('Rome Hotel A');
    // Florence, now at index 0, must not have received Rome's hotels.
    expect(cities[0].name).toBe('Florence');
    expect(cities[0].hotel.name).not.toBe('Rome Hotel A');
  });

  it('drops the result quietly if the visit was removed while the search was out', async () => {
    const rome = buildCity({ name: 'Rome' });
    rome.hotels = [rome.hotels[0]];
    const trip = buildTrip({ cities: [rome, buildCity({ name: 'Florence' })] });
    useTripStore.setState({ currentTrip: trip });

    let resolveRome: (v: any[]) => void = () => {};
    mockedSearchHotels.mockImplementation(
      (params: any) =>
        new Promise((resolve) => { if (params.city === 'Rome') resolveRome = resolve; else resolve([]); }),
    );

    render(<ResultsPage />);
    await waitFor(() => expect(mockedSearchHotels).toHaveBeenCalled());

    act(() => {
      const t = useTripStore.getState().currentTrip!;
      useTripStore.setState({ currentTrip: { ...t, cities: [t.cities[1]] } });
    });
    await act(async () => { resolveRome([{ name: 'Rome Hotel A', rating: 4, pricePerNight: 100, bookingUrl: '' }]); });

    const cities = useTripStore.getState().currentTrip!.cities;
    expect(cities).toHaveLength(1);
    expect(cities[0].hotel.name).not.toBe('Rome Hotel A');
  });
});

describe('flowchart keys a repeat visit as its own node', () => {
  it('renders Paris → Rome → Paris as three nodes with no duplicate-key warning', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const trip = buildTrip({
      cities: [
        buildCity({ name: 'Paris', dates: { arrival: '2026-06-15', departure: '2026-06-17' } }),
        buildCity({ name: 'Rome', dates: { arrival: '2026-06-17', departure: '2026-06-19' } }),
        buildCity({ name: 'Paris', dates: { arrival: '2026-06-19', departure: '2026-06-21' } }),
      ],
    });
    useTripStore.setState({ currentTrip: trip });

    render(<ResultsPage />);

    expect(screen.getAllByRole('heading', { name: 'Paris' })).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: 'Rome' })).toHaveLength(1);
    const dupKey = errors.mock.calls.some((c) => String(c[0]).includes('same key'));
    expect(dupKey).toBe(false);
    errors.mockRestore();
  });
});
