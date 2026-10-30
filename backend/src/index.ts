import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { logger } from './utils/logger';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error';
import {
  apiLimiter,
  canvasRoleLimiter,
  expensiveLimiter,
  locationLimiter,
  optimizeLimiter,
} from './middleware/rateLimit';
import { startPresetRefreshScheduler } from './services/presets';

const app = express();

// Behind Railway's proxy — trust the first hop so rate limiting and logging
// key off the real client IP (X-Forwarded-For), not the proxy's own IP.
app.set('trust proxy', 1);

// ─── Core middleware ──────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
    // Let the browser reuse a preflight answer for 2 hours. Every JSON POST
    // from the frontend is preflighted, and with no Access-Control-Max-Age
    // the browser keeps the answer for 5 s, so nearly every call paid an
    // extra round trip first (~135 ms measured against production). 7200 s
    // is Chrome's ceiling (Firefox allows a day). Caching is safe: the answer
    // depends only on the origin list and cors()'s defaults, and an origin
    // removed from the list still fails on the real response, which has to
    // carry Access-Control-Allow-Origin too.
    maxAge: 7200,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Rate limiting ────────────────────────────────────────────
// General cap on all /api traffic, plus a stricter cap on routes that hit
// paid external APIs (Anthropic, Duffel, RapidAPI) or are expensive to run.
app.use('/api', apiLimiter);
app.use(
  ['/api/optimize', '/api/plan', '/api/search', '/api/flights', '/api/hotels', '/api/trains'],
  expensiveLimiter,
);
// The optimize RUN fans out to dozens of Duffel searches, so it keeps a cap
// near its old one on top of the shared expensive cap (rateLimit.ts).
app.post('/api/optimize', optimizeLimiter);
// Their own budgets, excluded from the general one above — see rateLimit.ts
// for why a typeahead or a background poll sharing the planner's allowance
// 429s the planner.
app.use('/api/locations', locationLimiter);
app.get('/api/canvas/:tripId/role', canvasRoleLimiter);

// ─── Routes ───────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ name: 'voyza-backend', version: '0.1.0' });
});
app.use('/api', routes);

// ─── Error handling ──────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Boot ────────────────────────────────────────────────────
const server = app.listen(env.PORT, () => {
  logger.info('Backend listening', { port: env.PORT, env: env.NODE_ENV });
  // Weekly Browse price refresh (see services/presets.ts).
  if (env.NODE_ENV !== 'test') startPresetRefreshScheduler();
});

// Graceful shutdown — important when running behind a process manager
const shutdown = (signal: string) => {
  logger.info('Shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// For tests that drive the real app, middleware order and all. Importing this
// module starts the server, exactly as running it does.
export { app, server };
