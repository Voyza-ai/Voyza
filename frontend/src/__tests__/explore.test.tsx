import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ProtectedRoute redirects when signed out; the shared auth mock is
// signed in, but stub it to a passthrough so tests don't depend on it.
jest.mock('@/components/shared/ProtectedRoute', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
}));
jest.mock('@/components/shared/NotificationBell', () => ({
  __esModule: true,
  default: () => null,
}));

import ExplorePage from '@/app/explore/page';
import PopularTravelerTrips from '@/components/browse/PopularTravelerTrips';
import { getPopularTrips, cloneTrip, type PopularTrip } from '@/lib/api';

const mockedPopular = getPopularTrips as jest.MockedFunction<typeof getPopularTrips>;
const mockedClone = cloneTrip as jest.MockedFunction<typeof cloneTrip>;

const pt = (over: Partial<PopularTrip> = {}): PopularTrip => ({
  id: 'p1',
  title: 'Italy in 10 days',
  travelers: 2,
  totalCost: 2400,
  startDate: null,
  cloneCount: 12,
  clonesThisWeek: 3,
  createdAt: '2026-09-01T00:00:00Z',
  cities: [{ name: 'Rome', country: 'Italy' }, { name: 'Florence', country: 'Italy' }],
  tags: ['food', 'history'],
  ownerName: 'Pal',
  isMine: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedPopular.mockResolvedValue({ trips: [] });
});

describe('Explore page', () => {
  it('lists shared trips with route, tags, clone counts, and owner', async () => {
    mockedPopular.mockResolvedValue({ trips: [pt()] });
    render(<ExplorePage />);
    expect(await screen.findByText('Italy in 10 days')).toBeInTheDocument();
    expect(screen.getByText('Rome → Florence')).toBeInTheDocument();
    expect(screen.getByText('12 clones')).toBeInTheDocument();
    expect(screen.getByText('3 this week')).toBeInTheDocument();
    expect(screen.getByText('Shared by Pal')).toBeInTheDocument();
  });

  it('switches to trending and passes filters to the API', async () => {
    render(<ExplorePage />);
    await waitFor(() => expect(mockedPopular).toHaveBeenCalledWith(expect.objectContaining({ sort: 'popular' })));

    fireEvent.click(screen.getByText('Trending this week'));
    await waitFor(() =>
      expect(mockedPopular).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'trending' })),
    );

    fireEvent.click(screen.getByText('food'));
    await waitFor(() =>
      expect(mockedPopular).toHaveBeenLastCalledWith(expect.objectContaining({ vibe: 'food' })),
    );

    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '1000' } });
    await waitFor(() =>
      expect(mockedPopular).toHaveBeenLastCalledWith(expect.objectContaining({ maxBudget: 1000 })),
    );

    const city = screen.getByLabelText('Filter by city');
    fireEvent.change(city, { target: { value: 'Rome' } });
    fireEvent.submit(city.closest('form')!);
    await waitFor(() =>
      expect(mockedPopular).toHaveBeenLastCalledWith(expect.objectContaining({ cities: ['Rome'] })),
    );
  });

  it('cloning a trip opens the new copy', async () => {
    mockedPopular.mockResolvedValue({ trips: [pt()] });
    mockedClone.mockResolvedValue({ tripId: 'copy-1', trip: {}, clonedFrom: 'p1' });
    render(<ExplorePage />);
    fireEvent.click(await screen.findByText('Clone trip'));
    await waitFor(() => expect(mockedClone).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results?tripId=copy-1'));
  });

  it('your own shared trip shows Open instead of Clone', async () => {
    mockedPopular.mockResolvedValue({ trips: [pt({ isMine: true })] });
    render(<ExplorePage />);
    expect(await screen.findByText('Your trip')).toBeInTheDocument();
    expect(screen.queryByText('Clone trip')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Open'));
    expect(mockPush).toHaveBeenCalledWith('/results?tripId=p1');
  });

  it('shows an empty state that points to Share to Explore', async () => {
    render(<ExplorePage />);
    expect(await screen.findByText('No shared trips yet')).toBeInTheDocument();
    expect(screen.getByText(/Share to Explore/)).toBeInTheDocument();
  });
});

describe('Popular with travelers row (Browse)', () => {
  it('renders nothing when no trips are shared', async () => {
    const { container } = render(<PopularTravelerTrips />);
    await waitFor(() => expect(mockedPopular).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the top shared trips and links to Explore', async () => {
    mockedPopular.mockResolvedValue({ trips: [pt()] });
    render(<PopularTravelerTrips />);
    expect(await screen.findByText('Popular with travelers')).toBeInTheDocument();
    expect(mockedPopular).toHaveBeenCalledWith({ sort: 'popular', limit: 3 });
    fireEvent.click(screen.getByText('See all'));
    expect(mockPush).toHaveBeenCalledWith('/explore');
  });
});
