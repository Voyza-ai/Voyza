import type { MetadataRoute } from 'next';
import { catalogLastModified, fetchCatalogServer } from '@/lib/presetsServer';
import { SITE_URL } from '@/lib/site';

/** /sitemap.xml — public marketing + SEO pages only (app pages are private). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const catalog = await fetchCatalogServer();
  // The catalog's own newest refresh, not the request time: `new Date()` told
  // crawlers every page changed on every fetch, which is how a sitemap teaches
  // them to ignore its dates. Undefined (no catalog yet) omits the field.
  const lastModified = catalogLastModified(catalog);
  const fixed: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/browse`, lastModified, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE_URL}/trips`, lastModified, changeFrequency: 'weekly', priority: 0.8 },
  ];
  const categories: MetadataRoute.Sitemap = (catalog?.categories ?? []).map((c) => ({
    url: `${SITE_URL}/trips/${c.slug}`,
    lastModified,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));
  return [...fixed, ...categories];
}
