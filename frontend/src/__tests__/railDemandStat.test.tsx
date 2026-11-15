import './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import RailDemandStat from '@/components/main/RailDemandStat';

const api = jest.requireMock('@/lib/api');

describe('RailDemandStat', () => {
  it('shows the share with its counts', async () => {
    api.fetchRailDemand.mockResolvedValueOnce({ tripsWithLegs: 109, tripsWithTrain: 67, percent: 61, asOf: '' });
    render(<RailDemandStat />);
    const line = await screen.findByTestId('rail-demand-stat');
    expect(line).toHaveTextContent('61% of multi-city trips planned on BlueMurr include a train leg (67 of 109)');
  });

  it('shows nothing when there are too few trips, or on an error', async () => {
    api.fetchRailDemand.mockResolvedValueOnce({ tripsWithLegs: 3, tripsWithTrain: 3, percent: null, asOf: '' });
    const { unmount } = render(<RailDemandStat />);
    await waitFor(() => expect(api.fetchRailDemand).toHaveBeenCalled());
    expect(screen.queryByTestId('rail-demand-stat')).toBeNull();
    unmount();
    api.fetchRailDemand.mockRejectedValueOnce(new Error('down'));
    render(<RailDemandStat />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('rail-demand-stat')).toBeNull();
  });
});
