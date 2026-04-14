import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { getDuffel } from '../services/duffel';

const router = Router();

/**
 * Flight search — stub.
 * POST /api/flights/search
 *
 * This is a scaffold. The real implementation will call Duffel's
 * offer_requests endpoint, shape results for the frontend, and cache.
 */
const searchSchema = z.object({
  origin: z.string().length(3, 'IATA code required (3 letters)'),
  destination: z.string().length(3, 'IATA code required (3 letters)'),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  returnDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
  passengers: z.number().int().positive().default(1),
  cabinClass: z.enum(['economy', 'premium_economy', 'business', 'first']).default('economy'),
});

router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);

    // TODO: replace with real Duffel call once token is configured.
    const duffel = getDuffel();

    // Placeholder response shape — keep stable so the frontend can
    // wire against it before the real integration lands.
    void duffel;
    throw new AppError(501, 'Flight search not yet implemented', { input });
  }),
);

export default router;
