import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchHotels } from '../services/hotels';

const router = Router();

const searchSchema = z.object({
  city: z.string().min(1),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  adults: z.number().int().positive().default(2),
  rooms: z.number().int().positive().default(1),
  maxPrice: z.number().positive().optional(),
});

router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);
    const hotels = await searchHotels(input);
    res.json({ hotels });
  }),
);

export default router;
