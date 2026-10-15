import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NotificationBell from '@/components/shared/NotificationBell';
import { useNotificationsStore } from '@/store/notificationsStore';
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
  cloneTrip,
  type AppNotification,
} from '@/lib/api';
import { supabase } from '@/lib/supabase';

const mockedGet = getNotifications as jest.MockedFunction<typeof getNotifications>;
const mockedMarkRead = markNotificationRead as jest.MockedFunction<typeof markNotificationRead>;
const mockedMarkAll = markAllNotificationsRead as jest.MockedFunction<typeof markAllNotificationsRead>;
const mockedDelete = deleteNotification as jest.MockedFunction<typeof deleteNotification>;
const mockedClone = cloneTrip as jest.MockedFunction<typeof cloneTrip>;

const n = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: `n-${Math.random().toString(36).slice(2, 8)}`,
  type: 'canvas_invite',
  title: 'You were invited to collaborate on a trip',
  body: 'alice invited you to "Japan" as editor.',
  data: { tripId: 'trip-1', link: '/canvas/join/tok-1' },
  read_at: null,
  created_at: new Date().toISOString(),
  ...over,
});

/** The channel mock is a single shared object — grab its .on to reach the
 *  postgres_changes handler the hook registered. */
const capturedRealtimeHandler = () => {
  const channelObj = (supabase.channel as jest.Mock).mock.results[0]?.value;
  const call = channelObj.on.mock.calls.find((c: any[]) => c[0] === 'postgres_changes');
  return call?.[2];
};

beforeEach(() => {
  jest.clearAllMocks();
  useNotificationsStore.setState({ items: [], unreadCount: 0, loaded: false });
  mockedGet.mockResolvedValue({ notifications: [], unreadCount: 0 });
});

describe('NotificationBell', () => {
  it('shows no badge when everything is read', async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('shows the unread count from the initial fetch, capped at 9+', async () => {
    mockedGet.mockResolvedValue({ notifications: [n()], unreadCount: 3 });
    render(<NotificationBell />);
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('3');

    act(() => useNotificationsStore.setState({ unreadCount: 12 }));
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('9+');
  });

  it('opens the dropdown and lists notifications', async () => {
    mockedGet.mockResolvedValue({
      notifications: [
        n({ title: 'You were invited to collaborate on a trip' }),
        n({
          type: 'ownership_transferred',
          title: 'You are now the owner of a trip',
          body: 'Ownership of "Japan" was transferred to you.',
          data: { tripId: 'trip-2' },
        }),
      ],
      unreadCount: 2,
    });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    expect(screen.getByText('You were invited to collaborate on a trip')).toBeInTheDocument();
    expect(screen.getByText('You are now the owner of a trip')).toBeInTheDocument();
  });

  it('shows the empty state once loaded', async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(/Notifications/));
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('mark all read zeroes the badge and calls the API', async () => {
    mockedGet.mockResolvedValue({ notifications: [n(), n()], unreadCount: 2 });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByText('Mark all read'));

    expect(mockedMarkAll).toHaveBeenCalled();
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('Clear all empties the list and calls the API', async () => {
    mockedGet.mockResolvedValue({
      notifications: [n({ title: 'First' }), n({ title: 'Second', read_at: '2026-09-29T10:00:00Z' })],
      unreadCount: 1,
    });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByText('Clear all'));

    expect(clearAllNotifications as jest.Mock).toHaveBeenCalled();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('Clear all is disabled when the list is empty', async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(/Notifications/));
    expect(screen.getByText('Clear all')).toBeDisabled();
    expect(screen.getByText('Mark all read')).toBeDisabled();
  });

  it('a realtime INSERT prepends the row and bumps the badge', async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());

    const handler = capturedRealtimeHandler();
    expect(handler).toBeDefined();
    act(() => handler({ new: n({ title: 'Fresh from realtime' }) }));

    expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
    fireEvent.click(screen.getByLabelText(/Notifications/));
    expect(screen.getByText('Fresh from realtime')).toBeInTheDocument();
  });

  it('clicking a row marks it read and navigates by type', async () => {
    const item = n({
      id: 'n-own',
      type: 'ownership_transferred',
      title: 'You are now the owner of a trip',
      data: { tripId: 'trip-9' },
    });
    mockedGet.mockResolvedValue({ notifications: [item], unreadCount: 1 });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByText('You are now the owner of a trip'));

    expect(mockedMarkRead).toHaveBeenCalledWith('n-own');
    expect(mockPush).toHaveBeenCalledWith('/canvas/trip-9');
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('a canvas invite navigates to the working join URL', async () => {
    const item = n({
      id: 'n-inv',
      data: { tripId: 'trip-7', link: '/canvas/trip-7?share=tok-7' },
    });
    mockedGet.mockResolvedValue({ notifications: [item], unreadCount: 1 });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByText('You were invited to collaborate on a trip'));

    expect(mockPush).toHaveBeenCalledWith('/canvas/trip-7?share=tok-7');
  });

  it('heals legacy /canvas/join/ links into the real join URL (404 regression)', async () => {
    // Early notifications stored a link to a frontend page that never
    // existed; clicking them 404'd. The bell rebuilds the working URL.
    const item = n({
      id: 'n-legacy',
      data: { tripId: 'trip-8', link: '/canvas/join/tok-legacy' },
    });
    mockedGet.mockResolvedValue({ notifications: [item], unreadCount: 1 });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByText('You were invited to collaborate on a trip'));

    expect(mockPush).toHaveBeenCalledWith('/canvas/trip-8?share=tok-legacy');
  });

  it('the anonymized-owner notification clones the trip and opens the copy', async () => {
    const item = n({
      id: 'n-anon',
      type: 'trip_owner_anonymized',
      title: 'A trip owner deleted their account',
      data: { tripId: 'trip-1', tripTitle: 'Japan', action: 'clone' },
    });
    mockedGet.mockResolvedValue({ notifications: [item], unreadCount: 1 });
    mockedClone.mockResolvedValue({ tripId: 'trip-clone-1', trip: {}, clonedFrom: 'trip-1' });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByText('Clone trip'));

    await waitFor(() => expect(mockedClone).toHaveBeenCalledWith('trip-1'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/canvas/trip-clone-1'));
  });

  it('deleting a row removes it and calls the API without navigating', async () => {
    const item = n({ id: 'n-del', title: 'Delete me' });
    mockedGet.mockResolvedValue({ notifications: [item], unreadCount: 1 });
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');

    fireEvent.click(screen.getByLabelText(/Notifications/));
    fireEvent.click(screen.getByLabelText('Delete notification'));

    expect(mockedDelete).toHaveBeenCalledWith('n-del');
    expect(screen.queryByText('Delete me')).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
