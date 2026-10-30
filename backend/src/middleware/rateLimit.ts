import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';

// Skip rate limiting during tests AND local development — one plan run
// fires ~10 expensive-route calls, so a dev testing the planner a few
// times in a row would trip the guards that exist for production
// abuse. Never throttle the health check either (Railway's healthcheck +
// any monitors hit /api/health constantly).
const skip = (req: Request): boolean =>
  env.NODE_ENV === 'test' ||
  env.NODE_ENV === 'development' ||
  (req.originalUrl || '').startsWith('/api/health');

/**
 * THE BUDGET EVERY CAP BELOW IS SIZED AGAINST: one heavy user, one window.
 *
 * The caps used to be 30 expensive and 100 general calls per IP per 15
 * minutes, and normal use went straight through them. One planned trip is
 * 3N + 2 expensive calls — optimize, then hotels, activities and restaurants
 * for each of N cities, then chat-suggestions; 11 measured for 3 cities, 17
 * for 5 — plus one per planner chat turn. A second trip inside 15 minutes hit
 * the 31st call part-way through and lost its activities and restaurants, and
 * because the frontend swallows 429s it looked as if the city simply had
 * none. Each open canvas tab also polls its role every 25 s, 36 times a
 * window, so two tabs spent 72 of the general 100 before the user did
 * anything at all.
 *
 * A heavy session, per window:
 *
 *   10 five-city plans    10 × 17 = 170 expensive calls, 10 of them optimize
 *   a long planner chat   40 turns =  40 expensive calls
 *   follow-ups            home-leg searches, leg repairs, re-searched hotels:
 *                         not in 3N + 2, so they get the headroom
 *   2 canvas tabs open    2 × 37 role polls plus refocus refreshes, billed to
 *                         canvasRoleLimiter only
 *
 * 210 expensive calls before follow-ups.
 *
 * Keyed by IP, not by user, on purpose. The expensive routes are public —
 * planning works signed out — so most of this traffic has no user at all, and
 * a user id is only trustworthy after `supabase.auth.getUser`, a network round
 * trip this middleware would then add to every call. Reading the id out of an
 * UNVERIFIED token would let anyone mint a fresh budget per request. The cost
 * of IP keying is that people behind one NAT share a budget, which is why the
 * caps are sized for a heavy user rather than an average one: several moderate
 * users fit inside it. IP keying needs `app.set('trust proxy', 1)` (index.ts)
 * so we see the client behind Railway's proxy, not the proxy.
 */
const WINDOW_MS = 15 * 60 * 1000;

/** The caps, per IP per 15-minute window. Exported so tests read the same numbers. */
export const RATE_LIMITS = {
  general: 600,
  expensive: 300,
  optimize: 40,
  canvasRole: 600,
  locations: 600,
} as const;

/** `/api/canvas/<tripId>/role` — matched the way Express routes it: any case, optional trailing slash. */
const CANVAS_ROLE_POLL = /^\/api\/canvas\/[^/]+\/role\/?$/i;

function pathOf(req: Request): string {
  return (req.originalUrl || '').split('?')[0];
}

function isCanvasRolePoll(req: Request): boolean {
  // app.get() also answers HEAD, so canvasRoleLimiter sees both.
  return (req.method === 'GET' || req.method === 'HEAD') && CANVAS_ROLE_POLL.test(pathOf(req));
}

/**
 * Requests the GENERAL limiter must not count, because they have a limiter of
 * their own and would otherwise spend the planner's allowance.
 *
 * `/api/locations/resolve` is a typeahead target: one person naming their
 * origin city can spend a dozen calls on a single field. Counting those
 * against the shared general budget means the resolve calls 429 the actual
 * planning flow — the user gets "too many requests" on the thing they were
 * trying to do, caused by the autocomplete that was helping them.
 *
 * It is excluded rather than made generous because it is not the same kind of
 * route: a pure in-memory lookup with no database, no paid API and no network
 * call, measured at 0.005 ms on the exact path. It gets its own, much higher
 * cap below, so it is bounded without being billed to the planner.
 *
 * The canvas role poll is excluded for the same reason from the other side: a
 * background timer the user never sees must not be what 429s the thing they
 * are doing. It is metered by canvasRoleLimiter instead.
 */
const UNMETERED_BY_GENERAL_LIMITER = ['/api/locations'];

function meteredSeparately(req: Request): boolean {
  return (
    UNMETERED_BY_GENERAL_LIMITER.some((path) => (req.originalUrl || '').startsWith(path)) ||
    isCanvasRolePoll(req)
  );
}

/**
 * General limiter for ALL /api routes — generous for normal use, but stops
 * runaway scripts and basic abuse.
 *
 * Every expensive call is counted here too, so this has to sit well above
 * the expensive cap: 300 of those, plus the signed-in bookkeeping around a
 * plan (trip saves and loads, users/me, notifications, canvas sessions —
 * roughly 10 per plan, so ~100 for the heavy session), still leaves ~200
 * spare. 600 a window is 40 a minute sustained: no person does that, a
 * runaway script does.
 */
export const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: RATE_LIMITS.general,
  standardHeaders: true, // expose RateLimit-* headers
  legacyHeaders: false,
  skip: (req) => skip(req) || meteredSeparately(req),
  message: { error: 'Too many requests — please try again in a few minutes.' },
});

/**
 * Location resolution. High cap, because a typeahead is the point, and still a
 * cap, because an unbounded endpoint is an invitation.
 *
 * 600 per 15 minutes is roughly 40 a minute — far more than anyone types, far
 * less than a scraper wants. There is nothing to run up a bill with here; the
 * limit exists so one client cannot spend the process's CPU on fuzzy searches,
 * which are the expensive path at about 0.2 ms each.
 */
export const locationLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: RATE_LIMITS.locations,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: 'Too many location lookups — please slow down.' },
});

/**
 * GET /api/canvas/:tripId/role — the canvas's background role poll.
 *
 * Every open canvas tab calls it every 25 s whether or not anyone is looking,
 * and again on every refocus, so it is the one route whose volume scales with
 * tabs left open rather than with anything the user does. Its own budget,
 * excluded from the general one (see UNMETERED_BY_GENERAL_LIMITER).
 *
 * 600 a window is ~16 tabs polling from one IP — an office of collaborators
 * behind one NAT, each with a couple of canvases open. Each poll is one auth
 * lookup and one single-row read, so this bounds load rather than a bill.
 */
export const canvasRoleLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: RATE_LIMITS.canvasRole,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: 'Too many requests — please try again in a few minutes.' },
});

/**
 * Stricter limiter for routes that hit PAID external APIs (Anthropic, Duffel,
 * RapidAPI) or are expensive to run (route optimization). This is the
 * cost-abuse / brute-force guard — a scraper hammering these could otherwise
 * run up real API bills.
 *
 * 300 is the heavy session's 210 plus ~40% for the follow-ups 3N + 2 leaves
 * out. It is still a ceiling on spend, just a higher one: the dearest call
 * behind it is suggest-for-vibe, up to 2048 output tokens on Sonnet 4.5,
 * about 3.5¢ at list price, so one IP can spend roughly $10 a window on AI
 * here where it could spend roughly $1 before. The heaviest call of all,
 * optimize, keeps a cap near its old one — see optimizeLimiter.
 */
export const expensiveLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: RATE_LIMITS.expensive,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: 'Too many requests to this resource — please slow down.' },
});

/**
 * POST /api/optimize, on top of the expensive cap.
 *
 * One optimize is not one paid call but dozens — permutations × date-shift
 * probes × home airports, 50+ Duffel searches for a 5-city trip (flights.ts)
 * — all through the one Duffel token whose rate limit every user shares.
 * Under the shared cap alone, raising that to 300 would have let one IP fire
 * 300 optimizes a window, 15,000+ searches, where the old cap of 30 allowed
 * about 1,500.
 *
 * 40 is 4× the heavy session's 10 plans, and keeps one IP near the old
 * ceiling for the call that fans out hardest.
 *
 * Same message as expensiveLimiter: the client cannot tell the two apart and
 * has no reason to.
 */
export const optimizeLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: RATE_LIMITS.optimize,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: 'Too many requests to this resource — please slow down.' },
});
