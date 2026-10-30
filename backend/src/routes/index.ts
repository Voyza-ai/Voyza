import { Router } from 'express';
import { z } from 'zod';
import health from './health';
import flights from './flights';
import trains from './trains';
import hotels from './hotels';
import plan from './plan';
import canvas from './canvas';
import trips from './trips';
import users from './users';
import notifications from './notifications';
import locations from './locations';
import email from './email';
import presets from './presets';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { compareLeg } from '../services/compareLeg';
import { getCachedLegPrices } from '../services/legCache';
import { optimize } from '../services/optimizer';
import { getSupabase } from '../services/supabase';
import { addDays, todayIso } from '../utils/dates';

const router = Router();

/**
 * Mount all feature routers under a single /api tree.
 * Keep this file boring — just routing, no business logic.
 */
router.use('/health', health);
router.use('/flights', flights);
router.use('/trains', trains);
router.use('/hotels', hotels);
router.use('/plan', plan);
router.use('/canvas', requireAuth, canvas);
router.use('/trips', requireAuth, trips);
router.use('/users', requireAuth, users);
router.use('/notifications', requireAuth, notifications);
// No requireAuth: resolving a place name is the first thing the planner does,
// before anyone has signed in, and the answer is derived from a checked-in
// public dataset. Nothing user-scoped is readable through it.
router.use('/locations', locations);
// No requireAuth: unsubscribe links arrive from emails (no session), and
// run-jobs authenticates schedulers via the CRON_SECRET header itself.
router.use('/email', email);
// Public: backs the server-rendered SEO category pages (crawlers are signed out).
router.use('/presets', presets);

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
}).superRefine((input, ctx) => {
  // Inputs the optimizer used to accept and quietly turn into a broken trip.
  // Each is a 400 the planner already renders as an error message (zod →
  // 'ValidationError' in errorHandler → PlanningChat's existing copy).

  // Fewer nights than cities: distributeNights gave the tail cities 0
  // nights, so e.g. 3 cities in 2 nights came back with the last city
  // arriving and departing the same day — and a hotel searched for
  // checkin === checkout.
  if (input.totalNights !== undefined && input.totalNights < input.cities.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalNights'],
      message: 'Need at least one night per city',
    });
  }

  // A repeated city: `dates` is keyed by city name, so the second visit
  // overwrote the first (Paris, Rome, Paris came back as Rome → Paris →
  // Paris with one Paris date range and a Paris → Paris "leg"). Compared
  // trimmed and case-insensitive, the way the persistent caches
  // (airport_codes, leg_price_cache, train search) already key city names.
  const seen = new Set<string>();
  for (const city of input.cities) {
    const key = (typeof city === 'string' ? city : city.name).trim().toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cities'],
        message: 'Each city can appear only once',
      });
      break;
    }
    seen.add(key);
  }

  // A start date in the past: every leg date was silently clamped to
  // tomorrow (clampToFuture) while the trip's own dates kept the past ones,
  // so the calendar and the prices described different trips. One day of
  // grace for time zones: the server's date is UTC, and a traveller in the
  // Americas picking "today" in the evening is already a day behind it.
  if (input.startDate < addDays(todayIso(), -1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startDate'],
      message: 'Start date is in the past',
    });
  }
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

// ─── GET /api/optimize/:tripId ───────────────────────────────
// Cached leg prices for a SAVED trip. Trip-scoped, so it takes the same
// gate as GET /api/trips/:id — requireAuth plus an owner-or-member check.
// Before this it was anonymous and filtered `leg_price_cache.origin` (a
// city NAME) by a trip id, so a real trip id matched nothing while
// `GET /api/optimize/rome` dumped 20 cache rows — `raw_response` and all
// — to any caller. See services/legCache.ts for the actual lookup.
router.get(
  '/optimize/:tripId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { data: trip, error } = await supabase
      .from('trips')
      .select('id, user_id')
      .eq('id', req.params.tripId)
      .single();

    if (error || !trip) {
      throw new AppError(404, 'Trip not found');
    }

    // RLS handles access control, but verify ownership/membership
    if (trip.user_id !== user.id) {
      const { data: member } = await supabase
        .from('group_members')
        .select('id')
        .eq('trip_id', trip.id)
        .eq('user_id', user.id)
        .single();
      if (!member) {
        throw new AppError(403, 'Access denied');
      }
    }

    res.json({ cached: await getCachedLegPrices(trip.id) });
  }),
);

export default router;
