import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import { PRESET_ITINERARIES, presetNights, presetCost, presetCostFor } from '@/data/presetItineraries';
import { getPresetCatalog, saveTrip, sendPresetEvents, type PresetCatalog } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';

/**
 * The /browse flows a user drives, through the real page: the saved trip's
 * price for a chosen party (A2) and the ?preset= deep link (E13).
 */
const mockedCatalog = getPresetCatalog as jest.MockedFunction<typeof getPresetCatalog>;
const mockedEvents = sendPresetEvents as jest.Mock;

// The live catalog: same presets, as the API wraps them.
const live = (): PresetCatalog => ({
  presets: PRESET_ITINERARIES.map((data) => ({
    slug: data.slug,
    data,
    vibes: [],
    region: 'europe',
    nights: presetNights(data),
    estCost: presetCost(data),
    costPerPerson: Math.round(presetCost(data) / data.travelers),
    durationBucket: 'one-week',
    budgetTier: '$$',
    categories: [],
    heroImageUrl: null,
    staffPick: false,
    source: 'curated',
    refreshedAt: null,
    cloneCount: 0,
    viewCount: 0,
    impressionCount: 0,
    trendingScore: 0,
    origin: { region: 'us-east', city: 'New York', airport: 'JFK' },
  })),
  editorial: { staffPicks: [], trending: [] },
  categories: [],
});

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

describe('?preset= deep link (E13)', () => {
  it('opens once: the live catalog arriving does not reopen a closed modal, reset the party, or count a 2nd view', async () => {
    let resolveCatalog!: (c: PresetCatalog) => void;
    mockedCatalog.mockReturnValue(new Promise((r) => (resolveCatalog = r)));
    mockSearchParams.set('preset', 'paris-long-weekend');

    render(<BrowsePage />);
    expect(await screen.findByText('Plan a similar trip')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('More travelers'));
    expect(screen.getByText('3 travelers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Plan a similar trip')).not.toBeInTheDocument());

    await act(async () => {
      resolveCatalog(live());
    });

    expect(screen.queryByText('Plan a similar trip')).not.toBeInTheDocument();
    const views = mockedEvents.mock.calls.filter((c) => c[0]?.[0]?.kind === 'view');
    expect(views).toHaveLength(1);
  });

  it('keeps the chosen party size when the live catalog lands while the modal is open', async () => {
    let resolveCatalog!: (c: PresetCatalog) => void;
    mockedCatalog.mockReturnValue(new Promise((r) => (resolveCatalog = r)));
    mockSearchParams.set('preset', 'paris-long-weekend');

    render(<BrowsePage />);
    await screen.findByText('Plan a similar trip');
    fireEvent.click(screen.getByLabelText('More travelers'));
    await act(async () => {
      resolveCatalog(live());
    });
    expect(screen.getByText('3 travelers')).toBeInTheDocument();
  });

  it('a slug only the live catalog has still opens once that catalog arrives', async () => {
    const extra = { ...PRESET_ITINERARIES[0], slug: 'live-only-trip', title: 'Live Only Trip' };
    const cat = live();
    cat.presets.push({ ...cat.presets[0], slug: extra.slug, data: extra });
    let resolveCatalog!: (c: PresetCatalog) => void;
    mockedCatalog.mockReturnValue(new Promise((r) => (resolveCatalog = r)));
    mockSearchParams.set('preset', 'live-only-trip');

    render(<BrowsePage />);
    expect(screen.queryByText('Plan a similar trip')).not.toBeInTheDocument();
    await act(async () => {
      resolveCatalog(cat);
    });
    expect(await screen.findByText('Plan a similar trip')).toBeInTheDocument();
    expect(screen.getAllByText('Live Only Trip').length).toBeGreaterThan(0);
  });
});
