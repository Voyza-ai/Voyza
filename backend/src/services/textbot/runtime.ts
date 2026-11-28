import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { listBookings } from '../bookingStore';
import { TextBot } from './bot';
import { LoopbackChatEngine } from './chatEngine';
import { MemoryTextStore, type TextStore } from './store';
import { SupabaseTripLoader } from './tripLoader';
import { NudgeEngine, type BookingLookup, type NudgeLeg } from './nudges';
import { SendbluePoller, SendblueProvider, sendblueConfigFromEnv } from './providers/sendblue';
import { TwilioPoller, TwilioProvider, twilioConfigFromEnv } from './providers/twilio';
import type { TextProvider, TripLoader } from './types';

/**
 * Process-wide text bot. OFF unless TEXTBOT_MODE is set:
 *   TEXTBOT_MODE=poll       dev: poll the provider's API (no public webhook needed)
 *   TEXTBOT_MODE=webhook    later: the provider POSTs to /api/textbot/…/webhook
 *   TEXTBOT_PROVIDER=twilio | sendblue   (default sendblue)
 *   TEXTBOT_NUDGES=on       run the "Blue texts first" engine every 5 minutes
 *
 * Store: in memory (MemoryTextStore) until migration 016 is applied and the
 * owner OKs database writes. Applier: none yet — a YES answers with a link.
 */

let store: TextStore | null = null;
let bot: TextBot | null = null;
let poller: { stop(): void } | null = null;
let nudges: NudgeEngine | null = null;
let nudgeTimer: NodeJS.Timeout | null = null;
let botNumber: string | null = null;

export function textStore(): TextStore {
  if (!store) store = new MemoryTextStore();
  return store;
}

export function textBot(): TextBot | null {
  return bot;
}

export function nudgeEngine(): NudgeEngine | null {
  return nudges;
}

export function textBotNumber(): string | null {
  return botNumber ?? sendblueConfigFromEnv()?.fromNumber ?? twilioConfigFromEnv()?.fromNumber ?? null;
}

/**
 * A leg counts as booked when the trip owner has a CONFIRMED in-app booking
 * for this trip whose first slice leaves on the leg's date (and from the
 * leg's airport, when both are known). Rail can't be booked in-app yet, so
 * trains are always "not booked" — the nudge says so honestly.
 */
export class BookingStoreLookup implements BookingLookup {
  constructor(private trips: TripLoader) {}
  async isBooked(tripId: string, leg: NudgeLeg): Promise<boolean> {
    if (leg.mode !== 'flight' || !leg.departDate) return false;
    const members = await this.trips.members(tripId);
    const owner = [...members].find(([, r]) => r === 'owner')?.[0];
    if (!owner) return false;
    const recs = await listBookings(owner);
    return recs.some((b) => {
      if (b.trip_id !== tripId || b.status !== 'confirmed') return false;
      const s = (Array.isArray(b.slices) ? (b.slices as any[]) : [])[0];
      const date = String(s?.departingAt ?? '').slice(0, 10);
      const sameAirport = !leg.fromAirport || !s?.origin || s.origin === leg.fromAirport;
      return date === leg.departDate && sameAirport;
    });
  }
}

export function startTextBot(): void {
  const mode = (process.env.TEXTBOT_MODE ?? 'off').toLowerCase();
  if (mode === 'off') return;
  const which = (process.env.TEXTBOT_PROVIDER ?? 'sendblue').toLowerCase();
  const trips = new SupabaseTripLoader();

  let provider: TextProvider;
  let startPoll: (handle: (m: any) => Promise<unknown>) => { stop(): void; start(): void };
  if (which === 'twilio') {
    const cfg = twilioConfigFromEnv();
    if (!cfg) {
      logger.warn('TEXTBOT_PROVIDER=twilio but TWILIO_FROM_NUMBER / TWILIO_ACCOUNT_SID are missing — text bot OFF');
      return;
    }
    const p = new TwilioProvider(cfg);
    provider = p;
    botNumber = cfg.fromNumber;
    startPoll = (h) => new TwilioPoller(p, cfg.fromNumber, h);
  } else {
    const cfg = sendblueConfigFromEnv();
    if (!cfg) {
      logger.warn('TEXTBOT_MODE is set but SENDBLUE_FROM_NUMBER / SENDBLUE_API_KEY_ID are missing — text bot OFF');
      return;
    }
    const p = new SendblueProvider(cfg);
    provider = p;
    botNumber = cfg.fromNumber;
    startPoll = (h) => new SendbluePoller(p, cfg.fromNumber, h);
  }

  bot = new TextBot({
    store: textStore(),
    chat: new LoopbackChatEngine(),
    trips,
    provider,
    applier: null,
    config: { siteUrl: env.FRONTEND_URL },
  });
  if (mode === 'poll') {
    const b = bot;
    const pl = startPoll((m) => b.handle(m));
    pl.start();
    poller = pl;
  }

  nudges = new NudgeEngine({
    store: textStore(),
    trips,
    provider,
    bookings: new BookingStoreLookup(trips),
    config: { siteUrl: env.FRONTEND_URL },
  });
  if ((process.env.TEXTBOT_NUDGES ?? 'off').toLowerCase() === 'on') {
    const n = nudges;
    nudgeTimer = setInterval(() => void n.runOnce().catch(() => undefined), 5 * 60_000);
  }
  logger.info('Text bot started', { mode, provider: which, store: 'memory', nudges: !!nudgeTimer });
}

export function stopTextBot(): void {
  poller?.stop();
  poller = null;
  if (nudgeTimer) clearInterval(nudgeTimer);
  nudgeTimer = null;
}
