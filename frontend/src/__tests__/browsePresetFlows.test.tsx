import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import { PRESET_ITINERARIES, presetCostFor } from '@/data/presetItineraries';
import { getPresetCatalog, saveTrip } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';

/**
 * The /browse flows a user drives, through the real page.
 */
const mockedCatalog = getPresetCatalog as jest.MockedFunction<typeof getPresetCatalog>;

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams.delete('preset');
  mockedCatalog.mockResolvedValue({ presets: [], editorial: { staffPicks: [], trending: [] }, categories: [] });
});

describe('Save for a party of 4 (A2)', () => {
  it('the trip handed to saveTrip costs exactly what the modal quoted', async () => {
    const preset = PRESET_ITINERARIES.find((p) => p.slug === 'japan-golden-route')!;
    render(<BrowsePage />);
    fireEvent.click(screen.getByText(preset.title));
    fireEvent.click(screen.getByRole('button', { name: /more travelers/i }));
    fireEvent.click(screen.getByRole('button', { name: /more travelers/i }));
    expect(screen.getByText('4 travelers')).toBeInTheDocument();
    const quoted = `~$${presetCostFor(preset, 4).toLocaleString()}`;
    expect(screen.getByText(quoted)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    const payload = (saveTrip as jest.Mock).mock.calls[0][0];
    expect(payload.travelers).toBe(4);
    // Header total (before home flights) = the /browse quote.
    expect(liveTripTotal(payload)).toBe(presetCostFor(preset, 4));
  });
});
