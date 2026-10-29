import type { MetadataRoute } from 'next';
import { fetchCatalogServer } from '@/lib/presetsServer';
import { SITE_URL } from '@/lib/site';

/** /sitemap.xml — public marketing + SEO pages only (app pages are private). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const catalog = await fetchCatalogServer();
  const now = new Date();
  const fixed: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/browse`, lastModified: now, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE_URL}/trips`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
  ];
  const categories: MetadataRoute.Sitemap = (catalog?.categories ?? []).map((c) => ({
    url: `${SITE_URL}/trips/${c.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));
  return [...fixed, ...categories];
}
