import { API_URL } from './site';
import type { PresetCatalog, PresetCategory, PresetSummary } from './api';

/**
 * Server-side catalog reads for the SEO pages (server components, sitemap).
 * Cached with ISR: pages rebuild at most hourly, and a backend blip serves
 * the last good render instead of an error.
 */
const REVALIDATE_SECONDS = 3600;

export async function fetchCatalogServer(): Promise<PresetCatalog | null> {
  try {
    const res = await fetch(`${API_URL}/api/presets`, { next: { revalidate: REVALIDATE_SECONDS } });
    if (!res.ok) return null;
    return (await res.json()) as PresetCatalog;
  } catch {
    return null;
  }
}

export async function fetchCategoryServer(
  slug: string,
): Promise<{ category: PresetCategory; presets: PresetSummary[] } | null | 'not-found'> {
  try {
    const res = await fetch(`${API_URL}/api/presets/category/${encodeURIComponent(slug)}`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (res.status === 404) return 'not-found';
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
