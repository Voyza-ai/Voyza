import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

jest.mock('@/components/shared/NotificationBell', () => ({ __esModule: true, default: () => null }));

import BrowsePage from '@/app/browse/page';
import CategoryPage from '@/app/trips/[category]/page';
import { PRESET_ITINERARIES, presetCostFor, presetPricePerPersonRange } from '@/data/presetItineraries';
import { getPresetCatalog } from '@/lib/api';

/**
 * E10: a /browse quote is hotels + transport BETWEEN cities. The flights
 * from home are priced live once the trip is saved, so "~$1,344 for 4" on
 * Paris became $2,390 in the saved trip's header. The quote stays; every
 * place that shows it says what it leaves out.
 */
const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams.delete('preset');
  (getPresetCatalog as jest.Mock).mockResolvedValue({ presets: [], editorial: { staffPicks: [], trending: [] }, categories: [] });
});

describe('/browse', () => {
  it('every card says its per-person range leaves out the flights from home', () => {
    render(<BrowsePage />);
    for (const preset of PRESET_ITINERARIES) {
      const card = screen.getAllByText(preset.title)[0].closest('button')!;
      const { low, high } = presetPricePerPersonRange(preset);
      expect(card).toHaveTextContent(
        `$${low.toLocaleString()}–$${high.toLocaleString()} /person · excl. home flights`,
      );
    }
  });

  it('the detail modal says the same next to its quote, for the chosen party', () => {
    render(<BrowsePage />);
    fireEvent.click(screen.getByText(paris.title));
    fireEvent.click(screen.getByRole('button', { name: /more travelers/i }));
    fireEvent.click(screen.getByRole('button', { name: /more travelers/i }));
    const quote = screen.getByText(`~$${presetCostFor(paris, 4).toLocaleString()}`);
    expect(presetCostFor(paris, 4)).toBe(1344);
    expect(quote).toHaveTextContent('~$1,344 · excl. home flights');
  });
});

describe('/trips/[category]', () => {
  const realFetch = global.fetch;
  afterAll(() => {
    global.fetch = realFetch;
  });

  // The card's visible line stays as it was: these cards are narrower than
  // /browse's, and the note wraps the 4-digit ranges at 1440px. Its tooltip
  // and the structured-data offer say it instead.
  it('the SEO card tooltip and its JSON-LD offer say it too', async () => {
    const summary = {
      slug: paris.slug,
      data: paris,
      vibes: ['romance'],
      nights: 3,
      costPerPerson: 336,
      heroImageUrl: null,
      categories: ['weekend-getaways'],
    };
    const category = {
      slug: 'weekend-getaways',
      title: 'Weekend getaways',
      seoTitle: 't',
      metaDescription: 'd',
      intro: 'i',
      presetSlugs: [paris.slug],
    };
    global.fetch = jest.fn(async (url: string) =>
      url.includes('/api/presets/category/')
        ? { ok: true, status: 200, json: async () => ({ category, presets: [summary] }) }
        : { ok: true, status: 200, json: async () => ({ presets: [summary], editorial: { staffPicks: [], trending: [] }, categories: [category] }) },
    ) as any;
    const { container } = render(await CategoryPage({ params: { category: 'weekend-getaways' } }));
    const card = screen.getByText(paris.title).closest('a')!;
    expect(within(card).getByTitle('Per person: 2 sharing a room – solo, excluding flights from home')).toHaveTextContent(
      '$336–$672 / person',
    );
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.innerHTML);
    expect(ld[0].itemListElement[0].item.offers.description).toBe(
      'Estimated per person for 3 nights, excluding flights from home',
    );
  });
});
