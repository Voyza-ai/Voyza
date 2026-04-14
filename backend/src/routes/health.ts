import { Router } from 'express';
import { env } from '../config/env';

const router = Router();

/** Liveness check — returns 200 if the server is up. */
router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    env: env.NODE_ENV,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
