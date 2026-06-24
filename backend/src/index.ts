import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { logger } from './utils/logger';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter, expensiveLimiter } from './middleware/rateLimit';

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
});

// Graceful shutdown — important when running behind a process manager
const shutdown = (signal: string) => {
  logger.info('Shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
