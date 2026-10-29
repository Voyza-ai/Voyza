import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { env } from '../config/env';
import {
  buildCategoryRows,
  buildEditorialRows,
  loadCatalog,
  recordPresetEvents,
  refreshPresetPrices,
} from '../services/presets';

const router = Router();

/**
 * Browse catalog API. PUBLIC (mounted without requireAuth): it backs the
 * server-rendered SEO category pages, which crawlers fetch signed-out.
 * Read-only except the engagement beacon and the secret-guarded refresh.
 */

// ─── GET /api/presets — whole catalog + rows ─────────────────
// One call gives /browse everything: every published preset, the
// editorial rows (staff picks, trending this week), and the category rows.
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const catalog = await loadCatalog();
    res.json({
      presets: catalog,
      editorial: buildEditorialRows(catalog),
      categories: buildCategoryRows(catalog),
    });
  }),
);

// ─── GET /api/presets/category/:slug — SEO landing page data ─
router.get(
  '/category/:slug',
  asyncHandler(async (req, res) => {
    const catalog = await loadCatalog();
    const category = buildCategoryRows(catalog).find((c) => c.slug === req.params.slug);
    if (!category) throw new AppError(404, 'Category not found');
    const bySlug = new Map(catalog.map((p) => [p.slug, p]));
    res.json({
      category,
      presets: category.presetSlugs.map((s) => bySlug.get(s)).filter(Boolean),
    });
  }),
);

// ─── POST /api/presets/events — engagement beacon ────────────
// impression = card shown in a row, view = detail opened, use = saved or
// "Plan a similar trip". Feeds the trending row. Capped per request.
const eventsSchema = z.object({
  events: z
    .array(
      z.object({
        slug: z.string().min(1).max(120),
        kind: z.enum(['impression', 'view', 'use']),
      }),
    )
    .min(1)
    .max(50),
});

router.post(
  '/events',
  asyncHandler(async (req, res) => {
    const { events } = eventsSchema.parse(req.body);
    // Dedupe within one beacon so a re-render can't double-count.
    const seen = new Set<string>();
    const unique = events.filter((e) => {
      const k = `${e.slug}:${e.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const recorded = await recordPresetEvents(unique);
    res.json({ recorded });
  }),
);

// ─── POST /api/presets/run-refresh — weekly price refresh ────
// Point a weekly scheduler here (same CRON_SECRET as email run-jobs).
router.post(
  '/run-refresh',
  asyncHandler(async (req, res) => {
    if (!env.CRON_SECRET) throw new AppError(503, 'CRON_SECRET is not configured');
    if (req.headers['x-cron-secret'] !== env.CRON_SECRET) throw new AppError(401, 'Unauthorized');
    const result = await refreshPresetPrices();
    res.json({ success: true, ...result });
  }),
);

export default router;
