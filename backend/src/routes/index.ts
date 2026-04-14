import { Router } from 'express';
import { z } from 'zod';
import health from './health';
import flights from './flights';
import trains from './trains';
import hotels from './hotels';
import ai from './ai';
import plan from './plan';
import canvas from './canvas';
import { asyncHandler } from '../middleware/asyncHandler';
import { compareLeg } from '../services/compareLeg';
import { optimize } from '../services/optimizer';

const router = Router();

/**
 * Mount all feature routers under a single /api tree.
 * Keep this file boring — just routing, no business logic.
 */
router.use('/health', health);
router.use('/flights', flights);
router.use('/trains', trains);
router.use('/hotels', hotels);
router.use('/ai', ai);
router.use('/plan', plan);
router.use('/canvas', canvas);

// ─── Compare Leg ─────────────────────────────────────────────
const compareLegSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  travelers: z.number().int().positive().default(1),
  originCountry: z.string().optional(),
  destinationCountry: z.string().optional(),
});

router.post(
  '/search/compare-leg',
  asyncHandler(async (req, res) => {
    const input = compareLegSchema.parse(req.body);
    const result = await compareLeg(input);
    res.json(result);
  }),
);

// ─── Optimize ────────────────────────────────────────────────
// Accept cities as either string[] or { name, country? }[]
const cityItem = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), country: z.string().optional() }),
]);

const optimizeSchema = z.object({
  cities: z.array(cityItem).min(2),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  travelers: z.number().int().positive().default(1),
  budget: z.number().positive().optional(),
});

router.post(
  '/optimize',
  asyncHandler(async (req, res) => {
    const input = optimizeSchema.parse(req.body);
    // Normalize: strings become { name } objects
    const cities = input.cities.map((c) =>
      typeof c === 'string' ? { name: c } : c,
    );
    const result = await optimize({ ...input, cities });
    res.json(result);
  }),
);

router.get(
  '/optimize/:tripId',
  asyncHandler(async (req, res) => {
    // Return cached result from Supabase
    const { getSupabase } = require('../services/supabase');
    const supabase = getSupabase();
    const { data } = await supabase
      .from('leg_price_cache')
      .select('*')
      .eq('origin', req.params.tripId)
      .limit(20);
    res.json({ cached: data ?? [] });
  }),
);

export default router;
