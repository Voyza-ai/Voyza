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
  skip,
  message: { error: 'Too many requests — please try again in a few minutes.' },
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
