import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { hotelSearchLimiter } from '../middleware/rateLimit';
import { searchHotels } from '../services/hotels';

const router = Router();

const searchSchema = z.object({
  city: z.string().min(1),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  adults: z.number().int().positive().default(2),
  // No default here: an omitted room count is decided by `searchHotels`
  // (two adults to a room), so the canvas route and anything else that calls
  // the service directly get the same answer as this endpoint.
  rooms: z.number().int().positive().optional(),
  maxPrice: z.number().positive().optional(),
});

router.post(
  '/search',
  // Its own cap on top of the shared expensive one: every search spends
  // RapidAPI quota (see hotelSearchLimiter for the sizing).
  hotelSearchLimiter,
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);
    const hotels = await searchHotels(input);
    res.json({ hotels });
  }),
);

export default router;
