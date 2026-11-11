import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { TextBot } from './bot';
import { LoopbackChatEngine } from './chatEngine';
import { MemoryTextStore, type TextStore } from './store';
import { SupabaseTripLoader } from './tripLoader';
import { SendbluePoller, SendblueProvider, sendblueConfigFromEnv } from './providers/sendblue';
import type { TextProvider } from './types';

/**
 * Process-wide text bot. OFF unless TEXTBOT_MODE is set:
 *   TEXTBOT_MODE=poll     dev: poll Sendblue's API (no public webhook needed)
 *   TEXTBOT_MODE=webhook  later: Sendblue POSTs to /api/textbot/sendblue/webhook
 *
 * Store: in memory (MemoryTextStore) until migration 016 is applied and the
 * owner OKs database writes. Applier: none yet — a YES answers with a link to
 * the trip instead of editing it (see docs/IMESSAGE_BOT_PLAN.md).
 */

let store: TextStore | null = null;
let bot: TextBot | null = null;
let poller: SendbluePoller | null = null;

export function textStore(): TextStore {
  if (!store) store = new MemoryTextStore();
  return store;
}

export function textBot(): TextBot | null {
  return bot;
}

export function textBotNumber(): string | null {
  return sendblueConfigFromEnv()?.fromNumber ?? null;
}

export function startTextBot(): void {
  const mode = (process.env.TEXTBOT_MODE ?? 'off').toLowerCase();
  if (mode === 'off') return;
  const cfg = sendblueConfigFromEnv();
  if (!cfg) {
    logger.warn('TEXTBOT_MODE is set but SENDBLUE_FROM_NUMBER / SENDBLUE_API_KEY_ID are missing — text bot OFF');
    return;
  }
  const provider = new SendblueProvider(cfg);
  bot = new TextBot({
    store: textStore(),
    chat: new LoopbackChatEngine(),
    trips: new SupabaseTripLoader(),
    provider: provider as TextProvider,
    applier: null,
    config: { siteUrl: env.FRONTEND_URL },
  });
  if (mode === 'poll') {
    const b = bot;
    poller = new SendbluePoller(provider, cfg.fromNumber, (m) => b.handle(m));
    poller.start();
  }
  logger.info('Text bot started', { mode, provider: 'sendblue', store: 'memory' });
}

export function stopTextBot(): void {
  poller?.stop();
  poller = null;
}
