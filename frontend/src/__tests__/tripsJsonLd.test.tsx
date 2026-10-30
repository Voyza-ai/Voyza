import './mocks';
import React from 'react';
import { render } from '@testing-library/react';

jest.mock('@/components/shared/NotificationBell', () => ({ __esModule: true, default: () => null }));

import CategoryPage from '@/app/trips/[category]/page';
import { PRESET_ITINERARIES } from '@/data/presetItineraries';
import { catalogLastModified, serializeJsonLd } from '@/lib/presetsServer';

/**
 * Audit E21: the SEO page's JSON-LD went into an inline <script> through
 * plain JSON.stringify, so a `</script>` anywhere in preset text closed the
 * tag early and the rest became live HTML. And the sitemap stamped every
 * page lastModified = now.
 */
const HOSTILE = 'Sunsets </script><script>window.__pwned = 1</script> & more\u2028end';
const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;
const category = {
  slug: 'weekend-getaways',
  title: 'Weekend getaways',
  seoTitle: 'Long-Weekend Trips',
  metaDescription: 'Short trips.',
  intro: 'No week off?',
  presetSlugs: ['paris-long-weekend'],
};

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(async (url: string) => {
    if (url.includes('/api/presets/category/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          category,
          presets: [
            {
              slug: paris.slug,
              data: { ...paris, description: HOSTILE },
              vibes: ['romance'],
              nights: 3,
              costPerPerson: 820,
              heroImageUrl: null,
              categories: ['weekend-getaways'],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  }) as any;
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('JSON-LD escaping (E21)', () => {
  it('serializeJsonLd leaves no tag-closing or line-separator characters, and parses back unchanged', () => {
    const value = { description: HOSTILE };
    const out = serializeJsonLd(value);
    expect(out).not.toMatch(new RegExp('[<>&\\u2028\\u2029]'));
    expect(out).toContain('\\u2028');
    expect(JSON.parse(out)).toEqual(value);
  });

  it('a preset description containing </script> stays inside the JSON-LD script on the category page', async () => {
    const { container } = render(await CategoryPage({ params: { category: 'weekend-getaways' } }));
    const scripts = container.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    const raw = scripts[0].innerHTML;
    expect(raw).not.toMatch(/<\/script/i);
    const ld = JSON.parse(raw);
    expect(ld[0].itemListElement[0].item.description).toBe(HOSTILE);
  });
});

describe('catalogLastModified (sitemap date)', () => {
  const at = (refreshedAt: string | null) => ({ refreshedAt }) as any;
  it('is the newest price refresh in the catalog', () => {
    const d = catalogLastModified({
      presets: [at('2026-10-20T10:00:00Z'), at(null), at('2026-10-27T08:30:00Z')],
    } as any);
    expect(d?.toISOString()).toBe('2026-10-27T08:30:00.000Z');
  });

  it('is undefined — not now — when nothing has been refreshed or there is no catalog', () => {
    expect(catalogLastModified({ presets: [at(null), at(null)] } as any)).toBeUndefined();
    expect(catalogLastModified(null)).toBeUndefined();
  });
});
