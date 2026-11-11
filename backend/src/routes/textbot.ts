import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { SlidingLimiter } from '../services/textbot/rateLimit';
import { textBot, textBotNumber, textStore } from '../services/textbot/runtime';
import { SupabaseTripLoader } from '../services/textbot/tripLoader';
import { parseSendblueMessage, sendblueWebhookAuthorized } from '../services/textbot/providers/sendblue';
import { logger } from '../utils/logger';

/**
 * /api/textbot — the app side of the group-text assistant.
 *
 *   POST   /codes                   (auth) a one-time code to text the bot:
 *                                   kind "link" (owner/editor: link a chat to
 *                                   this trip) or "verify" (any member: prove
 *                                   your phone). 15-minute, single use.
 *   GET    /phone                   (auth) my verified phone, if any
 *   DELETE /phone                   (auth) forget my phone
 *   POST   /sendblue/webhook        Sendblue → us (secret header). Later phase:
 *                                   no webhook can reach a dev container.
 */
const router = Router();
const codeLimiter = new SlidingLimiter();
const trips = new SupabaseTripLoader();

const codeSchema = z.object({
  tripId: z.string().uuid(),
  kind: z.enum(['link', 'verify']),
});

router.post(
  '/codes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const { tripId, kind } = codeSchema.parse(req.body);
    if (!codeLimiter.take(`codes:${user.id}`, { limit: 10, ms: 60 * 60_000 })) {
      throw new AppError(429, 'Too many codes this hour — try again later');
    }
    const role = (await trips.members(tripId)).get(user.id);
    if (!role) throw new AppError(403, 'You are not on this trip');
    if (kind === 'link' && role === 'viewer') {
      throw new AppError(403, 'Only the trip owner or an editor can link a group chat');
    }
    const c = await textStore().createCode(kind, tripId, user.id);
    res.json({
      code: c.code,
      kind: c.kind,
      expiresAt: new Date(c.expiresAt).toISOString(),
      botNumber: textBotNumber(),
      textToSend: `${c.kind} ${c.code}`,
    });
  }),
);

router.get(
  '/phone',
  requireAuth,
  asyncHandler(async (req, res) => {
    const link = await textStore().phoneForUser((req as any).user.id);
    res.json({ phone: link?.phone ?? null, verifiedAt: link?.verifiedAt ?? null });
  }),
);

router.delete(
  '/phone',
  requireAuth,
  asyncHandler(async (req, res) => {
    await textStore().unlinkPhone((req as any).user.id);
    res.json({ phone: null });
  }),
);

router.post('/sendblue/webhook', (req, res): void => {
  if (!sendblueWebhookAuthorized(req.headers, process.env.SENDBLUE_WEBHOOK_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  // Ack first: Sendblue retries on 5xx/timeout (45 s) and the AI can be slow.
  // Retries are harmless — the bot drops repeated message_handles.
  res.status(200).json({ ok: true });
  const bot = textBot();
  const number = textBotNumber();
  if (!bot || !number) return;
  const inbound = parseSendblueMessage(req.body ?? {}, number);
  if (inbound) {
    bot.handle(inbound).catch((err) => logger.warn('textbot webhook handle failed', { message: err?.message }));
  }
});

export default router;
