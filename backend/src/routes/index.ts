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

// Field-level messages, kept in `details` as they were; the sentence a
// traveller reads is built from them in `optimizeErrorMessage`.
const FEWER_NIGHTS_THAN_CITIES = 'Need at least one night per city';
const CITY_REPEATED = 'Each city can appear only once';
const START_DATE_PAST = 'Start date is in the past';
const NOTHING_TO_TRAVEL = 'Need at least 2 cities, or 1 city with an origin set';

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
      message: FEWER_NIGHTS_THAN_CITIES,
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
        message: CITY_REPEATED,
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
      message: START_DATE_PAST,
    });
  }

  // One city and no home: nothing to travel between. optimize() refuses this
  // too, but with a plain Error, which reached the planner as a 500
  // "Internal Server Error". Same rule as its `hasOrigin`.
  if (input.cities.length === 1 && !(input.origin && input.origin.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cities'],
      message: NOTHING_TO_TRAVEL,
    });
  }
});

/** "2026-01-05" → "Jan 5, 2026"; the input itself when it is not a date. */
function niceDate(iso: unknown): string {
  const s = String(iso ?? '');
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(t)) return s;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The one sentence a traveller reads when /api/optimize refuses their trip.
 *
 * Every 400 here used to say 'ValidationError', which lib/api.ts throws as the
 * error's message and the planner turned into "I couldn't make sense of one of
 * your answers. Try rephrasing the dates or budget?" — for a trip whose only
 * problem was visiting Paris twice. Each problem the planner can actually send
 * now names what is wrong and what to do instead. `details` keeps zod's
 * field-level messages, so the response shape is what it was.
 *
 * One sentence for the FIRST problem, in the order a traveller would fix them
 * (where, when, how long, who), rather than a list: the planner shows it in a
 * chat bubble. Kept clear of the words "validation" and "fetch", which the
 * planner's error handler rewrites into its generic messages.
 */
export function optimizeErrorMessage(error: z.ZodError, body: unknown): string {
  const issues = error.issues;
  const on = (field: string) => issues.filter((i) => i.path[0] === field);
  const raw = (body ?? {}) as Record<string, unknown>;
  const cityNames = Array.isArray(raw.cities)
    ? raw.cities.map((c: any) => String(typeof c === 'string' ? c : c?.name ?? '').trim())
    : [];

  const cities = on('cities');
  if (cities.length > 0) {
    if (cities.some((i) => i.code === z.ZodIssueCode.too_small && i.path.length === 1)) {
      return 'Add at least one destination to plan a trip.';
    }
    if (cities.some((i) => i.message === CITY_REPEATED)) {
      const seen = new Map<string, string>();
      for (const name of cityNames) {
        const key = name.toLowerCase();
        const first = seen.get(key);
        if (first !== undefined) {
          return `${first} appears twice in your trip — to spend more time there, add nights to your first ${first} stay instead of returning to it.`;
        }
        seen.set(key, name);
      }
    }
    if (cities.some((i) => i.message === NOTHING_TO_TRAVEL)) {
      return 'Tell us where you are starting from, or add a second city, so there is a journey to plan.';
    }
    if (cities.some((i) => i.path.length > 1)) {
      return 'One of your destinations is blank — enter a city name for each stop.';
    }
  }

  const start = on('startDate');
  if (start.length > 0) {
    if (start.some((i) => i.message !== START_DATE_PAST)) return 'Choose a start date for your trip.';
    return `Your start date (${niceDate(raw.startDate)}) has already passed — pick today or a later date.`;
  }

  const nights = on('totalNights');
  if (nights.length > 0) {
    if (nights.some((i) => i.message === FEWER_NIGHTS_THAN_CITIES)) {
      const n = Number(raw.totalNights);
      return `Your ${n}-night trip has ${cityNames.length} cities — each city needs at least one night, so add nights or remove a city.`;
    }
    if (nights.some((i) => i.code === z.ZodIssueCode.too_big)) {
      return 'Trips can be at most 180 nights — choose a shorter date range.';
    }
    return 'Choose how many nights your trip lasts — at least one per city.';
  }

  if (on('travelers').length > 0) return 'A trip needs at least one traveler.';
  if (on('budget').length > 0) return 'Set a budget above $0, or skip the budget question.';
  if (on('origin').length > 0 || on('originAirports').length > 0) {
    return 'We could not read your home city — choose where you are starting from again.';
  }
  return 'Something in this trip request could not be read — check your destinations and dates, then try again.';
}

router.post(
  '/optimize',
  asyncHandler(async (req, res) => {
    const parsed = optimizeSchema.safeParse(req.body);
    if (!parsed.success) {
      // Same status and shape as the ZodError path in errorHandler
      // (`error` + `details`), with a sentence in `error`.
      throw new AppError(400, optimizeErrorMessage(parsed.error, req.body), parsed.error.flatten().fieldErrors);
    }
    const input = parsed.data;
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
