import { Router } from 'express';
import health from './health';
import flights from './flights';
import ai from './ai';

const router = Router();

/**
 * Mount all feature routers under a single /api tree.
 * Keep this file boring — just routing, no business logic.
 */
router.use('/health', health);
router.use('/flights', flights);
router.use('/ai', ai);

export default router;
