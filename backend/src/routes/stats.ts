import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { getRailDemand } from '../services/railDemand';

/**
 * Public aggregate numbers about how BlueMurr is used. Counts only — no trip,
 * person or route is identifiable from them.
 */
const router = Router();

// GET /api/stats/rail-demand — share of planned multi-city trips with a train leg.
router.get(
  '/rail-demand',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await getRailDemand());
  }),
);

export default router;
