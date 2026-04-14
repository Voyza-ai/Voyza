import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { getAnthropic, DEFAULT_MODEL } from '../services/anthropic';

const router = Router();

/**
 * POST /api/ai/chat
 * Generic Claude passthrough for planning-assistant messages.
 *
 * The frontend never talks to Anthropic directly — all requests
 * funnel through here so the API key stays server-side and we
 * can add rate limiting, logging, and prompt templating later.
 */
const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  system: z.string().optional(),
  maxTokens: z.number().int().positive().max(4096).default(1024),
});

router.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const { messages, system, maxTokens } = chatSchema.parse(req.body);

    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    });

    res.json({
      id: response.id,
      model: response.model,
      content: response.content,
      stopReason: response.stop_reason,
      usage: response.usage,
    });
  }),
);

export default router;
