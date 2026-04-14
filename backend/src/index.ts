import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { logger } from './utils/logger';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error';

const app = express();

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
