import { Router } from 'express';
import { z } from 'zod';
import health from './health';
import flights from './flights';
import trains from './trains';
import hotels from './hotels';
import ai from './ai';
import plan from './plan';
import canvas from './canvas';
import trips from './trips';
import users from './users';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
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
router.use('/canvas', requireAuth, canvas);
router.use('/trips', requireAuth, trips);
router.use('/users', requireAuth, users);

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
  // Minimum 1 city — single-destination trips (typical of vibe-first
  // "I want an adventure" → "Reykjavik") still need to go through
  // optimize so the home→first_city + last_city→home legs get built.
  // Previously required 2+ which forced the frontend into a bare
  // single-city path that skipped all the home-anchor machinery.
  cities: z.array(cityItem).min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  travelers: z.number().int().positive().default(1),
  budget: z.number().positive().optional(),
  /** Home city the user is flying from. When present, we test full city
   *  permutations, add home→first_city to each, and (if returnToHome)
   *  last_city→home. Absent = legacy behavior (fixed first, no home legs). */
  origin: z.string().min(1).optional(),
  /** Origin IATA codes. Prefilled from the originAirports.ts lookup on
   *  the frontend. Passed through verbatim. */
  originAirports: z.array(z.string().min(3).max(4)).optional(),
  /** Round-trip (true) or one-way (false). Defaults to true. */
  returnToHome: z.boolean().optional(),
  /**
   * Total nights for the trip. When omitted the optimizer defaults to
   * 2 nights per city. When set, distributed evenly across cities.
   */
  totalNights: z.number().int().positive().max(180).optional(),
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
