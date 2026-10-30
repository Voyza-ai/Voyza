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

/**
 * JSON for an inline <script type="application/ld+json">. JSON.stringify
 * alone is not safe there: a preset whose text contains `</script>` would
 * end the tag and the rest would be parsed as HTML (audit E21). Writing
 * `<`, `>` and `&` — plus U+2028 / U+2029, which JavaScript treats as
 * newlines — as JSON unicode escapes keeps it one inert JSON string that
 * parses back to exactly the same value.
 */
// From an escaped string, so this source file never holds the raw U+2028 /
// U+2029 characters (line terminators: one inside a regex literal breaks it).
const LINE_SEPARATORS = new RegExp('[\\u2028\\u2029]', 'g');

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/**
 * When the catalog last changed, for sitemap `lastModified`: the newest
 * price refresh across its presets. Undefined when no preset has been
 * refreshed (the bundled catalog, and the DB until the refresh is switched
 * on) — leaving `lastModified` out is honest, while `new Date()` told
 * crawlers every page changed on every hourly rebuild (audit E21).
 */
export function catalogLastModified(catalog: PresetCatalog | null): Date | undefined {
  let newest: number | undefined;
  for (const p of catalog?.presets ?? []) {
    const t = p.refreshedAt ? Date.parse(p.refreshedAt) : NaN;
    if (Number.isFinite(t) && (newest === undefined || t > newest)) newest = t;
  }
  return newest === undefined ? undefined : new Date(newest);
}

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
