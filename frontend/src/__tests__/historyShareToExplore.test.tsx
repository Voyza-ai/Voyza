import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('@/components/shared/ProtectedRoute', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
}));
jest.mock('@/components/shared/NotificationBell', () => ({
  __esModule: true,
  default: () => null,
}));

import HistoryPage from '@/app/history/page';
import { updateTripPermissions } from '@/lib/api';

const mockedPerms = updateTripPermissions as jest.MockedFunction<typeof updateTripPermissions>;

const ownedTrip = {
  id: 'trip-1',
  title: 'Japan Golden Route',
  status: 'active',
  travelers: 2,
  total_cost: 3000,
  savings_vs_alternative: 0,
  created_at: '2026-09-01T00:00:00Z',
  city_count: 3,
  cities: ['Tokyo', 'Kyoto', 'Osaka'],
  is_public: false,
};

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ trips: [ownedTrip], shared: [] }),
  }) as any;
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('My Trips — Share to Explore', () => {
  it('toggles a private trip public (optimistically) via the permissions API', async () => {
    render(<HistoryPage />);
    const sw = await screen.findByRole('switch', { name: /Share Japan Golden Route to Explore/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await waitFor(() =>
      expect(mockedPerms).toHaveBeenCalledWith('trip-1', { isPublic: true }),
    );
  });

  it('rolls the switch back when the server refuses', async () => {
    mockedPerms.mockRejectedValueOnce(new Error('403'));
    render(<HistoryPage />);
    const sw = await screen.findByRole('switch', { name: /Share Japan Golden Route to Explore/ });
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });
});
