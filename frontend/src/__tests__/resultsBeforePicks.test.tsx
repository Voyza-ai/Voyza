import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  useTripStore,
  startTripPicks,
  tripPicksSettled,
  restoreTripSession,
  cityPicksLoading,
  FAILED_PICKS_GRACE_MS,
  type CityPicks,
  type CityPicksRequest,
} from '@/store/tripStore';
import { saveTrip, searchActivities, searchRestaurants } from '@/lib/api';
import ResultsHeader from '@/components/results/ResultsHeader';
import CityActivitiesCard from '@/components/results/CityActivitiesCard';
import Flowchart from '@/components/results/Flowchart';
import type { Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

/**
 * /results opens before the trip's AI picks (activities, restaurants) are in;
 * they land on the trip in the store when they answer (startTripPicks). These
 * pin what happens to them around everything a traveller can do meanwhile.
 */

const mockedActivities = searchActivities as jest.MockedFunction<typeof searchActivities>;
const mockedRestaurants = searchRestaurants as jest.MockedFunction<typeof searchRestaurants>;
const mockedSave = saveTrip as jest.MockedFunction<typeof saveTrip>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const activity = (city: string) => ({
  name: `${city} museum`,
  category: 'museum' as const,
  timeOfDay: 'morning' as const,
  durationHours: 2,
  reason: '',
});
const restaurant = (city: string) => ({
  name: `${city} bistro`,
  cuisine: 'French',
  priceRange: '$$' as const,
  mealType: 'dinner' as const,
  reason: '',
});
const picksFor = (city: string): CityPicks => ({ activities: [activity(city)], restaurants: [restaurant(city)] });
const NONE: CityPicks = { activities: [], restaurants: [] };
const req = (city: string): CityPicksRequest => ({ city, travelers: 2, nights: 2 });

/** A freshly planned trip: no picks yet, no home anchor, never saved. */
function plannedTrip(): Trip {
  const t = buildTrip();
  return {
    ...t,
    id: undefined,
    origin: undefined,
    cities: [
      ...t.cities,
      // A third stop, after the fixture's last.
      { ...t.cities[t.cities.length - 1], name: 'Barcelona', country: 'Spain', dates: { arrival: '2026-06-20', departure: '2026-06-22' } },
    ].map((c) => ({ ...c, activities: [], restaurants: [], schedule: {} })),
  } as Trip;
}

const store = () => useTripStore.getState();
const SESSION_KEY = 'bluemurr-current-trip';

function pageEvent(type: 'pagehide' | 'pageshow', persisted = false) {
  const ev = new Event(type);
  Object.defineProperty(ev, 'persisted', { value: persisted });
  window.dispatchEvent(ev);
}

beforeAll(() => {
  let id = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++id);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  pageEvent('pageshow'); // back on the page: no unload in progress
  useTripStore.setState({ currentTrip: null, tripPicks: null, restoredFromSession: false });
  sessionStorage.clear();
});

it('lands each city as it answers; a failed one is left as before and nothing keeps waiting', async () => {
  jest.useFakeTimers();
  const trip = plannedTrip();
  const names = trip.cities.map((c) => c.name);
  const calls = names.map(() => deferred<CityPicks>());
  startTripPicks(trip, names.map(req), calls.map((d) => d.promise));

  expect(names.every((n) => cityPicksLoading(store().tripPicks, store().currentTrip, n))).toBe(true);

  await act(async () => calls[1].resolve(picksFor(names[1])));
  expect(store().currentTrip!.cities.map((c) => c.activities)).toEqual([[], [`${names[1]} museum`], []]);
  expect(cityPicksLoading(store().tripPicks, store().currentTrip, names[1])).toBe(false);

  await act(async () => {
    calls[0].reject(new Error('502'));
    calls[2].resolve(NONE);
  });
  // A failure is taken in once the page has stayed FAILED_PICKS_GRACE_MS (it
  // may be the page's own departure killing the request).
  expect(store().tripPicks!.pending.map((r) => r.city)).toEqual([names[0], names[2]]);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(FAILED_PICKS_GRACE_MS);
  });
  jest.useRealTimers();
  expect(store().tripPicks!.pending).toEqual([]);
  expect(store().currentTrip!.cities[0].activities).toEqual([]);
  expect(store().currentTrip!.cities[2].restaurants).toEqual([]);
  await expect(tripPicksSettled()).resolves.toBe(false);
});

it('a reload mid-load asks again for the cities still waiting, and they land', async () => {
  const trip = plannedTrip();
  const names = trip.cities.map((c) => c.name);
  const first = deferred<CityPicks>();
  const never = new Promise<CityPicks>(() => {});
  startTripPicks(trip, names.map(req), [first.promise, never, never]);
  await act(async () => first.resolve(picksFor(names[0])));

  const saved = sessionStorage.getItem(SESSION_KEY)!;
  expect(JSON.parse(saved).picks.pending.map((r: CityPicksRequest) => r.city)).toEqual(names.slice(1));

  // The reloaded page: a fresh store, the tab's snapshot.
  useTripStore.setState({ currentTrip: null, tripPicks: null });
  sessionStorage.setItem(SESSION_KEY, saved);
  mockedActivities.mockImplementation(async ({ city }) => [activity(city)]);
  mockedRestaurants.mockImplementation(async ({ city }) => [restaurant(city)]);
  await act(async () => {
    expect(restoreTripSession()).toBe(true);
  });

  await waitFor(() => expect(store().tripPicks!.pending).toEqual([]));
  expect(mockedActivities.mock.calls.map((c) => c[0].city)).toEqual(names.slice(1));
  expect(store().currentTrip!.cities.map((c) => c.activities)).toEqual(names.map((n) => [`${n} museum`]));
});

it('requests the reload itself kills are not failures: the cities stay waiting for the next page', async () => {
  const trip = plannedTrip();
  const name = trip.cities[0].name;
  const call = deferred<CityPicks>();
  startTripPicks(trip, [req(name)], [call.promise]);

  pageEvent('pagehide');
  // What the aborted fetches come back as: requestCityPicks's empty lists.
  await act(async () => call.resolve(NONE));
  expect(store().tripPicks!.pending.map((r) => r.city)).toEqual([name]);
  expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!).picks.pending).toHaveLength(1);

  // Restored from the back/forward cache instead: asked again, and it lands.
  mockedActivities.mockImplementation(async ({ city }) => [activity(city)]);
  mockedRestaurants.mockImplementation(async ({ city }) => [restaurant(city)]);
  await act(async () => pageEvent('pageshow', true));
  await waitFor(() => expect(store().tripPicks!.pending).toEqual([]));
  expect(store().currentTrip!.cities[0].activities).toEqual([`${name} museum`]);
});

it('an older copy of the trip (an AI date proposal) keeps the landed picks; a city the traveller emptied stays empty', async () => {
  const trip = plannedTrip();
  const names = trip.cities.map((c) => c.name);
  const calls = names.map(() => deferred<CityPicks>());
  startTripPicks(trip, names.map(req), calls.map((d) => d.promise));
  // The proposal is the trip as it was when the chat message went out.
  const proposal: Trip = JSON.parse(JSON.stringify(store().currentTrip));

  await act(async () => calls.forEach((d, i) => d.resolve(picksFor(names[i]))));
  act(() => store().updateCity(2, { activities: [], restaurants: [] }));
  act(() => store().setTrip(proposal));

  expect(store().currentTrip!.cities.map((c) => c.activities)).toEqual([
    [`${names[0]} museum`],
    [`${names[1]} museum`],
    [],
  ]);
});

it('a newer search replaces the older one: its late picks never land', async () => {
  const name = plannedTrip().cities[0].name;
  const older = deferred<CityPicks>();
  const newer = deferred<CityPicks>();
  startTripPicks(plannedTrip(), [req(name)], [older.promise]);
  startTripPicks(plannedTrip(), [req(name)], [newer.promise]);

  await act(async () => older.resolve(picksFor('Old')));
  expect(store().currentTrip!.cities[0].activities).toEqual([]);
  expect(store().tripPicks!.pending).toHaveLength(1);

  await act(async () => newer.resolve(picksFor(name)));
  expect(store().currentTrip!.cities[0].activities).toEqual([`${name} museum`]);
});

describe('Edit in Canvas (signed in: the shared auth mock)', () => {
  it('waits for the picks on "Saving...", saves the trip with them, then opens the canvas in this tab', async () => {
    const trip = plannedTrip();
    const name = trip.cities[0].name;
    const call = deferred<CityPicks>();
    startTripPicks(trip, [req(name)], [call.promise]);
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);

    render(<ResultsHeader trip={store().currentTrip!} />);
    fireEvent.click(screen.getByText('Edit in Canvas'));
    expect(await screen.findByText('Saving...')).toBeInTheDocument();
    expect(mockedSave).not.toHaveBeenCalled();

    await act(async () => call.resolve(picksFor(name)));
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
    expect(mockedSave.mock.calls[0][0].cities[0].activities).toEqual([`${name} museum`]);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/canvas/trip-123'));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('with nothing loading, saves at once and opens a new tab, as before', async () => {
    const trip = plannedTrip();
    startTripPicks(trip, [], []);
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);

    render(<ResultsHeader trip={store().currentTrip!} />);
    fireEvent.click(screen.getByText('Edit in Canvas'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/canvas/trip-123', '_blank'));
    expect(mockPush).not.toHaveBeenCalledWith('/canvas/trip-123');
    open.mockRestore();
  });
});

describe('the "Activities & Dining" card while the picks load', () => {
  const noop = () => {};

  it('keeps its place with faded lines, and opens nothing', () => {
    const city = plannedTrip().cities[0];
    const onToggleExpand = jest.fn();
    render(
      <CityActivitiesCard
        city={city}
        cityIndex={0}
        isActive={false}
        isDimmed={false}
        expanded={false}
        loading
        onHover={noop}
        onLeave={noop}
        onToggleExpand={onToggleExpand}
      />,
    );
    const card = screen.getByLabelText('Loading activities and dining');
    expect(card).toHaveTextContent('Activities & Dining');
    fireEvent.click(card);
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('is not drawn for a city with no picks that is not loading (a failed request), as before', () => {
    const { container } = render(
      <CityActivitiesCard
        city={plannedTrip().cities[0]}
        cityIndex={0}
        isActive={false}
        isDimmed={false}
        expanded={false}
        onHover={noop}
        onLeave={noop}
        onToggleExpand={noop}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('the flowchart shows it for each city still waiting, and the real card once the picks land', async () => {
    const trip = plannedTrip();
    const names = trip.cities.map((c) => c.name);
    const calls = names.map(() => deferred<CityPicks>());
    startTripPicks(trip, names.map(req), calls.map((d) => d.promise));

    const { rerender } = render(<Flowchart trip={store().currentTrip!} />);
    expect(screen.getAllByLabelText('Loading activities and dining')).toHaveLength(names.length);

    await act(async () => calls[0].resolve(picksFor(names[0])));
    rerender(<Flowchart trip={store().currentTrip!} />);
    expect(screen.getAllByLabelText('Loading activities and dining')).toHaveLength(names.length - 1);
    expect(screen.getByText(`${names[0]} museum`)).toBeInTheDocument();
  });
});
