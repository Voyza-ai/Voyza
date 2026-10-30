import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('@/components/shared/NotificationBell', () => ({ __esModule: true, default: () => null }));

import BrowsePage from '@/app/browse/page';
import CategoryPage from '@/app/trips/[category]/page';
import { PRESET_ITINERARIES, presetNights, type PresetItinerary } from '@/data/presetItineraries';
import { getPresetCatalog } from '@/lib/api';

/** D-19: "1 cities" in the preset modal — and the other counts beside it. */
const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;
// A one-night, one-city trip: every count on the card and modal is 1.
const oneNight: PresetItinerary = {
  ...paris,
  slug: 'one-night-in-paris',
  title: 'One Night in Paris',
  cities: [{ ...paris.cities[0], nights: 1 }],
};
const catalogOf = (presets: PresetItinerary[]) => ({
  presets: presets.map((data) => ({
    slug: data.slug,
    data,
    vibes: [],
    region: 'europe',
    nights: presetNights(data),
    estCost: 100,
    costPerPerson: 50,
    durationBucket: 'weekend',
    budgetTier: '$',
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
});

it('the preset modal says "1 city", and "5 cities" still for five', () => {
  (getPresetCatalog as jest.Mock).mockResolvedValue({ presets: [], editorial: { staffPicks: [], trending: [] }, categories: [] });
  render(<BrowsePage />);
  fireEvent.click(screen.getByText(paris.title));
  expect(screen.getByText('1 city')).toBeInTheDocument();
  expect(screen.queryByText(/1 cities/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getAllByText('Grand Asia Expedition')[0]);
  expect(screen.getByText('5 cities')).toBeInTheDocument();
});

it('one night reads "1 night" in the modal and the filter sidebar', async () => {
  (getPresetCatalog as jest.Mock).mockResolvedValue(catalogOf([oneNight]));
  render(<BrowsePage />);
  fireEvent.click(await screen.findByText(oneNight.title));
  // The sidebar's trip-length minimum, the modal header and the city's card.
  expect(screen.getAllByText('1 night', { selector: 'span' })).toHaveLength(3);
  expect(screen.queryByText(/\b1 nights\b/)).not.toBeInTheDocument();
  // "1 of 1 itineraries shown" → "1 of 1 itinerary shown"
  expect(screen.getByText(/1 of 1 itinerary shown/)).toBeInTheDocument();
});

it('the SEO card says "1 night"', async () => {
  const realFetch = global.fetch;
  const category = { slug: 'weekend-getaways', title: 'W', seoTitle: 't', metaDescription: 'd', intro: 'i', presetSlugs: [oneNight.slug] };
  const summary = { ...catalogOf([oneNight]).presets[0], nights: 1 };
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ category, presets: [summary] }) })) as any;
  const { container } = render(await CategoryPage({ params: { category: 'weekend-getaways' } }));
  global.fetch = realFetch;
  expect(screen.getByText('1 night')).toBeInTheDocument();
  const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.innerHTML);
  expect(ld[0].itemListElement[0].item.offers.description).toBe(
    'Estimated per person for 1 night, excluding flights from home',
  );
});
