import { API_URL } from './site';
import type { PresetCatalog, PresetCategory, PresetSummary } from './api';

/**
 * Server-side catalog reads for the SEO pages (server components, sitemap).
 * Cached with ISR: pages rebuild at most hourly, and a backend blip serves
 * the last good render instead of an error.
 */
const REVALIDATE_SECONDS = 3600;

/** The exact error the backend's GET /api/presets/category/:slug sends for an
 *  unknown category (backend/src/routes/presets.ts). Keep the two in sync. */
const CATEGORY_NOT_FOUND = 'Category not found';

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
    if (res.status === 404) {
      // Only the presets API's own "no such category" answer is a real 404.
      // A backend without /api/presets at all (production until this ships)
      // also answers 404 — Express's catch-all `{ error: 'Not Found' }` —
      // and treating that as not-found turned every category page into a
      // hard 404 instead of the "temporarily unavailable" state.
      const body = await res.json().catch(() => null);
      return body?.error === CATEGORY_NOT_FOUND ? 'not-found' : null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
