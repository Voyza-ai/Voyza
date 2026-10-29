import './mocks';
import { mockPush, mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import {
  PRESET_ITINERARIES,
  presetNights,
  presetCost,
  presetCostFor,
  type PresetItinerary,
} from '@/data/presetItineraries';
import { getPresetCatalog, sendPresetEvents, type PresetCatalog, type PresetSummary } from '@/lib/api';

const mockedCatalog = getPresetCatalog as jest.MockedFunction<typeof getPresetCatalog>;
const mockedEvents = sendPresetEvents as jest.Mock;

const summary = (data: PresetItinerary, over: Partial<PresetSummary> = {}): PresetSummary => ({
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
  heroImageUrl: data.coverImage ?? null,
  staffPick: false,
  source: 'curated',
  refreshedAt: null,
  cloneCount: 0,
  viewCount: 0,
  impressionCount: 0,
  trendingScore: 0,
  origin: { region: 'us-east', city: 'New York', airport: 'JFK' },
  ...over,
});

const japan = PRESET_ITINERARIES.find((p) => p.slug === 'japan-golden-route')!;
const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;

// A NEW, longer + pricier generated trip than anything bundled — exercises
// the "bounds widen when the live catalog loads" path.
const epic: PresetItinerary = {
  ...japan,
  slug: 'epic-generated-trip',
  title: 'Epic Generated Odyssey',
  cities: japan.cities.map((c) => ({ ...c, nights: c.nights + 8 })),
};

const liveCatalog = (): PresetCatalog => ({
  presets: [
    ...PRESET_ITINERARIES.map((p) =>
      summary(p, {
        staffPick: p.slug === 'japan-golden-route',
        categories: p.slug === 'paris-long-weekend' ? ['weekend-getaways'] : [],
      }),
    ),
    summary(epic, { source: 'generated', trendingScore: 9 }),
  ],
  editorial: { staffPicks: ['japan-golden-route'], trending: ['epic-generated-trip'] },
  categories: [
    {
      slug: 'weekend-getaways',
      title: 'Weekend getaways',
      seoTitle: 's',
      metaDescription: 'm',
      intro: 'i',
      presetSlugs: ['paris-long-weekend'],
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  mockSearchParams.delete('preset');
  mockedCatalog.mockResolvedValue({ presets: [], editorial: { staffPicks: [], trending: [] }, categories: [] });
});

describe('Browse — live catalog', () => {
  it('keeps the bundled presets when the API returns nothing (offline fallback)', async () => {
    render(<BrowsePage />);
    await waitFor(() => expect(mockedCatalog).toHaveBeenCalled());
    expect(screen.getByText('Japan Golden Route')).toBeInTheDocument();
    expect(screen.queryByLabelText('Staff picks')).not.toBeInTheDocument();
  });

  it('renders staff picks, trending, and category rows with See-all links', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    render(<BrowsePage />);
    const staff = await screen.findByRole('region', { name: 'Staff picks' });
    expect(within(staff).getByText('Japan Golden Route')).toBeInTheDocument();
    const trending = screen.getByRole('region', { name: 'Trending this week' });
    expect(within(trending).getByText('Epic Generated Odyssey')).toBeInTheDocument();
    const weekend = screen.getByRole('region', { name: 'Weekend getaways' });
    expect(within(weekend).getByText('See all').closest('a')).toHaveAttribute('href', '/trips/weekend-getaways');
    // Impressions beacon for the rendered row cards.
    expect(mockedEvents).toHaveBeenCalledWith(
      expect.arrayContaining([{ slug: 'japan-golden-route', kind: 'impression' }]),
    );
  });

  it('a newly loaded longer/pricier trip is NOT hidden by the untouched sliders', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    render(<BrowsePage />);
    // Appears in the main grid (not just the trending row).
    await waitFor(() =>
      expect(screen.getAllByText('Epic Generated Odyssey').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('lays every trip out in headed sections inside the main grid, 3 per row', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    const { container } = render(<BrowsePage />);
    await screen.findByRole('region', { name: 'Staff picks' });
    const headings = Array.from(container.querySelectorAll('section > div > h2')).map(
      (h) => h.childNodes[h.childNodes.length - 2]?.textContent ?? h.textContent,
    );
    expect(headings).toEqual(['Staff picks', 'Trending this week', 'Weekend getaways', 'All trips']);
    // Every section's grid is the 3-column layout.
    for (const grid of Array.from(container.querySelectorAll('section .grid'))) {
      expect(grid.className).toContain('lg:grid-cols-3');
    }
    // All trips holds the whole catalog (11 curated + 1 generated here).
    const all = screen.getByRole('region', { name: 'All trips' });
    expect(within(all).getAllByRole('button')).toHaveLength(PRESET_ITINERARIES.length + 1);
  });

  it('sidebar filters narrow every section and hide sections they empty', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    render(<BrowsePage />);
    await screen.findByRole('region', { name: 'Staff picks' });
    // Max 5 nights: Japan (staff pick, 9n) and the epic trip drop out, so
    // Staff picks and Trending have nothing left and disappear.
    fireEvent.change(screen.getByRole('slider', { name: /trip length/i }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    expect(screen.queryByRole('region', { name: 'Staff picks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Trending this week' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Weekend getaways' })).getByText('Paris Long Weekend')).toBeInTheDocument();
  });

  it('the sidebar "Jump to" list names every section and scrolls to it', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    } as any;
    render(<BrowsePage />);
    const nav = await screen.findByRole('navigation', { name: /jump to section/i });
    const items = within(nav).getAllByRole('button').map((b) => b.textContent);
    expect(items).toEqual([
      'Staff picks1',
      'Trending this week1',
      'Weekend getaways1',
      `All trips${PRESET_ITINERARIES.length + 1}`,
    ]);
    fireEvent.click(within(nav).getByText('Weekend getaways'));
    expect(scrolled).toEqual(['section-weekend-getaways']);
  });

  it('cards show a category badge, a mini-flowchart route, and a per-person price range', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    const { presetPricePerPersonRange } = require('@/data/presetItineraries');
    render(<BrowsePage />);
    const weekend = await screen.findByRole('region', { name: 'Weekend getaways' });
    const card = within(weekend).getByText('Paris Long Weekend').closest('button')!;
    // Category badge (Paris is in "Weekend getaways" in this catalog).
    expect(within(card).getByTestId('category-badge')).toHaveTextContent('WEEKEND GETAWAYS');
    // Mini-flowchart: one chip per city, in order.
    const route = within(card).getByRole('list', { name: 'Route' });
    expect(within(route).getAllByRole('listitem').map((li) => li.textContent)).toEqual(
      paris.cities.map((c) => c.name),
    );
    // Price range: 2 sharing a room → solo.
    const { low, high } = presetPricePerPersonRange(paris);
    expect(low).toBeLessThan(high);
    expect(card).toHaveTextContent(`$${low.toLocaleString()}–$${high.toLocaleString()} /person`);
  });

  it('presetPricePerPersonRange: shared room per person vs solo', () => {
    const { presetPricePerPersonRange, presetCostFor } = require('@/data/presetItineraries');
    expect(presetPricePerPersonRange(paris)).toEqual({
      low: Math.round(presetCostFor(paris, 2) / 2),
      high: presetCostFor(paris, 1),
    });
  });

  it('searching collapses everything into one "Search results" section', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    render(<BrowsePage />);
    await screen.findByRole('region', { name: 'Staff picks' });
    fireEvent.change(screen.getByPlaceholderText(/Describe your trip/i), { target: { value: 'iceland' } });
    expect(screen.getByRole('region', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'All trips' })).not.toBeInTheDocument();
  });

  it('hides the rows while searching', async () => {
    mockedCatalog.mockResolvedValue(liveCatalog());
    render(<BrowsePage />);
    await screen.findByRole('region', { name: 'Staff picks' });
    fireEvent.change(screen.getByPlaceholderText(/Describe your trip/i), { target: { value: 'iceland' } });
    expect(screen.queryByRole('region', { name: 'Staff picks' })).not.toBeInTheDocument();
  });

  it('?preset=<slug> deep link opens that trip and records a view', async () => {
    mockSearchParams.set('preset', 'paris-long-weekend');
    render(<BrowsePage />);
    expect(await screen.findByText('Plan a similar trip')).toBeInTheDocument();
    expect(mockedEvents).toHaveBeenCalledWith([{ slug: 'paris-long-weekend', kind: 'view' }]);
  });
});

describe('Plan a similar trip', () => {
  it('stages the preset shape for a fresh optimize and autoruns the planner', async () => {
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Paris Long Weekend'));
    fireEvent.click(await screen.findByText('Plan a similar trip'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/plan?resume=1&autorun=1'));
    const staged = JSON.parse(sessionStorage.getItem('bluemurr-autorun')!);
    expect(staged.destinations).toEqual(paris.cities.map((c) => c.name));
    expect(staged.travelers).toBe(paris.travelers);
    expect(staged.returnToHome).toBe(true);
    expect(staged.budget).toBe(presetCostFor(paris, paris.travelers));
    // Same length as the preset, dated ~30 days out.
    const nights =
      (new Date(staged.dateRange.end).getTime() - new Date(staged.dateRange.start).getTime()) / 86_400_000;
    expect(Math.round(nights)).toBe(presetNights(paris));
    // No geolocation in jsdom → the New York (JFK) default origin.
    expect(staged.origin).toBe('New York');
    expect(mockedEvents).toHaveBeenCalledWith([{ slug: 'paris-long-weekend', kind: 'use' }]);
  });

  it('clears leftover answers from an earlier plan (they would override the preset)', async () => {
    const { useTripStore } = require('@/store/tripStore');
    // A previous planning session left a 30-night answer behind — nights
    // outranks the date range in the optimizer, so it must not survive.
    useTripStore.setState({ answers: { nights: 30, destinations: ['Tokyo'] } });
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Paris Long Weekend'));
    fireEvent.click(await screen.findByText('Plan a similar trip'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/plan?resume=1&autorun=1'));
    expect(useTripStore.getState().answers.nights).toBeUndefined();
    expect(useTripStore.getState().answers.destinations).toBeUndefined();
  });
});
