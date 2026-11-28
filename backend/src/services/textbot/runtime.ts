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
import { TwilioGroupPoller, TwilioGroups } from './providers/twilioGroups';
import type { TextProvider, TripLoader } from './types';
import { readFileSync } from 'fs';
import { toE164 } from './phone';
import type { MemberRole } from './store';

/**
 * DEMO MODE (dev only, no database): TEXTBOT_DEMO_TRIP_FILE points at a trip
 * JSON in the GET /api/trips/:id `trip` shape (e.g. a read-only copy of a
 * saved trip); TEXTBOT_DEMO_PHONES="+1…:owner,+1…:editor" are its members,
 * already verified. Nothing is read from or written to Supabase. A link code
 * for the owner is printed at startup. Labelled in every log line.
 */
export class DemoTripLoader implements TripLoader {
  readonly tripId: string;
  private trip: any;
  readonly people: Array<{ phone: string; userId: string; role: MemberRole }>;
  constructor(file: string, phones: string) {
    this.trip = JSON.parse(readFileSync(file, 'utf8'));
    this.tripId = String(this.trip.id ?? 'demo-trip');
    this.people = phones
      .split(',')
      .map((x, i) => {
        const [raw, role] = x.split(':');
        const phone = toE164(raw ?? '');
        const r = (role === 'owner' || role === 'editor' || role === 'viewer' ? role : 'viewer') as MemberRole;
        return phone ? { phone, userId: `demo-user-${i + 1}`, role: r } : null;
      })
      .filter((p): p is { phone: string; userId: string; role: MemberRole } => !!p);
  }
  async load(id: string) {
    return id === this.tripId ? { trip: this.trip, title: String(this.trip.title ?? 'Trip'), updatedAt: 'demo' } : null;
  }
  async members(id: string) {
    const m = new Map<string, MemberRole>();
    if (id === this.tripId) for (const p of this.people) m.set(p.userId, p.role);
    return m;
  }
}

/**
 * Process-wide text bot. OFF unless TEXTBOT_MODE is set:
 *   TEXTBOT_MODE=poll       dev: poll the provider's API (no public webhook needed)
 *   TEXTBOT_MODE=webhook    later: the provider POSTs to /api/textbot/…/webhook
 *   TEXTBOT_PROVIDER=twilio | sendblue   (default sendblue)
 *   TWILIO_THREADS=group | dm            (default group) which Twilio inbox to poll.
 *     One at a time on purpose: whether a group MMS ALSO shows up in the 1:1
 *     Messages list is unverified, and polling both could answer it twice.
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
  const demoFile = process.env.TEXTBOT_DEMO_TRIP_FILE;
  const demo = demoFile ? new DemoTripLoader(demoFile, process.env.TEXTBOT_DEMO_PHONES ?? '') : null;
  const trips: TripLoader = demo ?? new SupabaseTripLoader();

  let provider: TextProvider;
  let startPoll: (handle: (m: any) => Promise<unknown>) => { stop(): void; start(): void };
  if (which === 'twilio') {
    const cfg = twilioConfigFromEnv();
    if (!cfg) {
      logger.warn('TEXTBOT_PROVIDER=twilio but TWILIO_FROM_NUMBER / TWILIO_ACCOUNT_SID are missing — text bot OFF');
      return;
    }
    const dm = new TwilioProvider(cfg);
    const groups = new TwilioGroups(cfg);
    // Sends route by thread id: "conv:…" → Conversations, "dm:…" → Messaging.
    provider = {
      name: 'twilio',
      send: (m) => (m.threadId.startsWith('conv:') ? groups.send(m) : dm.send(m)),
    };
    botNumber = cfg.fromNumber;
    const threads = (process.env.TWILIO_THREADS ?? 'group').toLowerCase();
    startPoll = (h) =>
      threads === 'dm' ? new TwilioPoller(dm, cfg.fromNumber, h) : new TwilioGroupPoller(groups, cfg.fromNumber, h);
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
  if (demo) {
    const s = textStore();
    for (const p of demo.people) void s.linkPhone(p.userId, p.phone);
    const owner = demo.people.find((p) => p.role === 'owner');
    if (owner) {
      void s.createCode('link', demo.tripId, owner.userId, 24 * 3_600_000).then((c) =>
        logger.info('[DEMO MODE] text this into the group to link it', { text: `link ${c.code}`, tripId: demo.tripId }),
      );
    }
  }
  logger.info('Text bot started', { mode, provider: which, store: 'memory', nudges: !!nudgeTimer, demo: !!demo });
}

export function stopTextBot(): void {
  poller?.stop();
  poller = null;
  if (nudgeTimer) clearInterval(nudgeTimer);
  nudgeTimer = null;
}
