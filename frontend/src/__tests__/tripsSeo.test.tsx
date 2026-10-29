import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/components/shared/NotificationBell', () => ({ __esModule: true, default: () => null }));

import CategoryPage, { generateMetadata } from '@/app/trips/[category]/page';
import TripsIndexPage from '@/app/trips/page';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import { PRESET_ITINERARIES } from '@/data/presetItineraries';

const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;
const category = {
  slug: 'weekend-getaways',
  title: 'Weekend getaways',
  seoTitle: 'Long-Weekend Trips from NYC — 4 Nights or Less',
  metaDescription: 'Short international getaways from New York.',
  intro: 'No week off? No problem.',
  presetSlugs: ['paris-long-weekend'],
};
const parisSummary = {
  slug: paris.slug,
  data: paris,
  vibes: ['romance', 'art'],
  nights: 3,
  costPerPerson: 820,
  heroImageUrl: 'https://upload.wikimedia.org/x.jpg',
  categories: ['weekend-getaways'],
};

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(async (url: string) => {
    if (url.includes('/api/presets/category/weekend-getaways')) {
      return { ok: true, status: 200, json: async () => ({ category, presets: [parisSummary] }) };
    }
    if (url.includes('/api/presets/category/')) return { ok: false, status: 404, json: async () => ({}) };
    if (url.endsWith('/api/presets')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          presets: [parisSummary],
          editorial: { staffPicks: [], trending: [] },
          categories: [category, { ...category, slug: 'beach-escapes', title: 'Beach escapes' }],
        }),
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  }) as any;
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('SEO category landing page (/trips/[category])', () => {
  it('server-renders the heading, intro, trips, and links into Browse', async () => {
    render(await CategoryPage({ params: { category: 'weekend-getaways' } }));
    expect(screen.getByRole('heading', { level: 1, name: 'Weekend getaways' })).toBeInTheDocument();
    expect(screen.getByText('No week off? No problem.')).toBeInTheDocument();
    expect(screen.getByText('Paris Long Weekend').closest('a')).toHaveAttribute(
      'href',
      '/browse?preset=paris-long-weekend',
    );
    // Internal links to sibling categories (SEO).
    expect(screen.getByText('Beach escapes').closest('a')).toHaveAttribute('href', '/trips/beach-escapes');
  });

  it('embeds schema.org TouristTrip + BreadcrumbList JSON-LD', async () => {
    const { container } = render(await CategoryPage({ params: { category: 'weekend-getaways' } }));
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.innerHTML);
    expect(ld[0]['@type']).toBe('ItemList');
    expect(ld[0].itemListElement[0].item['@type']).toBe('TouristTrip');
    expect(ld[0].itemListElement[0].item.offers).toMatchObject({ price: 820, priceCurrency: 'USD' });
    expect(ld[0].itemListElement[0].item.potentialAction).toMatchObject({
      '@type': 'TravelAction',
      fromLocation: { '@type': 'Place', name: 'New York (JFK)' },
      toLocation: { '@type': 'City', name: 'Paris' },
      target: 'https://bluemurr.com/browse?preset=paris-long-weekend',
    });
    expect(ld[1]['@type']).toBe('BreadcrumbList');
  });

  it('builds title, description, canonical URL, and Open Graph metadata', async () => {
    const meta = await generateMetadata({ params: { category: 'weekend-getaways' } });
    expect(meta.title).toBe('Long-Weekend Trips from NYC — 4 Nights or Less | BlueMurr');
    expect(meta.description).toBe('Short international getaways from New York.');
    expect(meta.alternates?.canonical).toBe('https://bluemurr.com/trips/weekend-getaways');
    expect((meta.openGraph as any).images[0].url).toBe('https://upload.wikimedia.org/x.jpg');
  });

  it('unknown categories 404', async () => {
    await expect(CategoryPage({ params: { category: 'nope' } })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('/trips index, sitemap, robots', () => {
  it('lists every category with its trip count', async () => {
    render(await TripsIndexPage());
    expect(screen.getByText('Weekend getaways').closest('a')).toHaveAttribute('href', '/trips/weekend-getaways');
    expect(screen.getAllByText('1 trip →')).toHaveLength(2);
  });

  it('sitemap includes the public pages and every category page', async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://bluemurr.com/',
        'https://bluemurr.com/browse',
        'https://bluemurr.com/trips',
        'https://bluemurr.com/trips/weekend-getaways',
        'https://bluemurr.com/trips/beach-escapes',
      ]),
    );
  });

  it('robots keeps private app pages out and points at the sitemap', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(['/canvas/', '/results', '/plan', '/history']));
    expect(r.sitemap).toBe('https://bluemurr.com/sitemap.xml');
  });
});
