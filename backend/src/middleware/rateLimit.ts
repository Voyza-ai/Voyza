import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';

// Skip rate limiting during tests AND local development — one plan run
// fires ~10 expensive-route calls, so a dev testing the planner a few
// times in a row trips the 30/15min guard that exists for production
// abuse. Never throttle the health check either (Railway's healthcheck +
// any monitors hit /api/health constantly).
const skip = (req: Request): boolean =>
  env.NODE_ENV === 'test' ||
  env.NODE_ENV === 'development' ||
  (req.originalUrl || '').startsWith('/api/health');

/**
 * Paths the GENERAL limiter must not count.
 *
 * `/api/locations/resolve` is a typeahead target: one person naming their
 * origin city can spend a dozen calls on a single field. Counting those
 * against the shared 100-per-15-minutes budget means the resolve calls 429
 * the actual planning flow — the user gets "too many requests" on the thing
 * they were trying to do, caused by the autocomplete that was helping them.
 *
 * It is excluded rather than made generous because it is not the same kind of
 * route: a pure in-memory lookup with no database, no paid API and no network
 * call, measured at 0.005 ms on the exact path. It gets its own, much higher
 * cap below, so it is bounded without being billed to the planner.
 */
const UNMETERED_BY_GENERAL_LIMITER = ['/api/locations'];

/**
 * General limiter for ALL /api routes — generous for normal use, but stops
 * runaway scripts and basic abuse. Keys off client IP (requires
 * `app.set('trust proxy', 1)` so we see the real IP behind Railway's proxy,
 * not the proxy's own IP).
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true, // expose RateLimit-* headers
  legacyHeaders: false,
  skip: (req) =>
    skip(req) ||
    UNMETERED_BY_GENERAL_LIMITER.some((path) => (req.originalUrl || '').startsWith(path)),
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
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: 'Too many location lookups — please slow down.' },
});

/**
 * Stricter limiter for routes that hit PAID external APIs (Anthropic, Duffel,
 * RapidAPI) or are expensive to run (route optimization). This is the
 * cost-abuse / brute-force guard — a scraper hammering /api/optimize could
 * otherwise run up real API bills.
 */
export const expensiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: 'Too many requests to this resource — please slow down.' },
});
