import { logger } from '../../utils/logger';
import { maskPhone } from './phone';
import type { TextStore, ThreadLink } from './store';
import { localParts, timeZoneForCity, zonedToUtc } from './timeZones';
import type { TextProvider, TripLoader } from './types';

/**
 * "Blue texts first" — the proactive nudge engine.
 *
 * Deciding WHETHER to nudge is plain code (no AI). Every run:
 *   for each trip with a linked thread → candidate nudges from rules →
 *   gates (privacy, consent, opt-out, mute, trip ended, quiet hours, daily
 *   budget, expiry) → the single most urgent → CLAIM in the ledger → send →
 *   mark sent. Claim-before-send means a crash or a second worker can never
 *   send the same nudge twice; the cost is that a crash mid-send drops it.
 *
 * Nudge texts are templates built from trip data: no AI, no made-up facts.
 */

export type LegMode = 'flight' | 'train' | 'bus' | 'other';

export type NudgeLeg = {
  id: string; // "home→Venice", "Venice→Rome", "Rome→home"
  kind: 'outbound' | 'intercity' | 'return';
  from: string;
  to: string;
  /** City whose local clock the departure time is in. */
  departCity: string;
  departCountry: string | null;
  mode: LegMode;
  operator: string | null;
  departDate: string | null; // YYYY-MM-DD, local
  departTime: string | null; // HH:MM, local
  fromAirport: string | null;
};

export type Nudge = {
  key: string; // ledger key, unique per trip
  kind: 'leave_now' | 'unbooked_leg';
  urgency: number; // higher wins
  text: string;
  /** UTC ms after which sending it is pointless (e.g. "leave now" 2 h late). */
  expiresAt: number;
};

/** Whether a leg is booked. Unknown is treated as NOT booked for "unbooked" and NOT booked for leave-now. */
export interface BookingLookup {
  isBooked(tripId: string, leg: NudgeLeg): Promise<boolean>;
}

export type NudgeConfig = {
  siteUrl: string;
  maxPerDayTravelling: number;
  maxPerDayBefore: number;
  quietStartHour: number; // 21 → 21:00
  quietEndHour: number; // 8 → 08:00
  unbookedWithinDays: number;
  /** Minutes before departure to leave, by mode (same buffers as the day planner). */
  leaveBufferMin: Record<LegMode, number>;
  /** Also send leave-now for legs not known to be booked. Off by default. */
  leaveNowForUnbooked: boolean;
  /** Minimum minutes between two nudges for one trip; leave-now is exempt. */
  minGapMin: number;
};

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  siteUrl: 'http://localhost:3000',
  maxPerDayTravelling: 3,
  maxPerDayBefore: 1,
  quietStartHour: 21,
  quietEndHour: 8,
  unbookedWithinDays: 14,
  leaveBufferMin: { flight: 120, train: 30, bus: 15, other: 30 },
  leaveNowForUnbooked: false,
  minGapMin: 180,
};

const MIN = 60_000;
const DAY = 86_400_000;

// ─── trip → legs ────────────────────────────────────────────────────────

function modeOf(m: unknown): LegMode {
  const s = String(m ?? '').toLowerCase();
  return s === 'flight' || s === 'train' || s === 'bus' ? (s as LegMode) : 'other';
}

/**
 * Every leg in travel order, from the trip shape buildTripFromDb returns.
 * (A trimmed cousin of tripLegs() on fix/ai-chat-home-legs; switch to that
 * once it is on dev.)
 */
export function legsForNudges(trip: any): NudgeLeg[] {
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  if (!cities.length) return [];
  const legs: NudgeLeg[] = [];
  const home = trip?.origin?.city ?? null;
  const out = trip?.origin?.outboundLeg;
  if (home && out) {
    legs.push({
      id: `home→${cities[0].name}`, kind: 'outbound', from: home, to: cities[0].name,
      departCity: home, departCountry: null, mode: 'flight', operator: out.operator ?? null,
      departDate: out.departDate ?? null, departTime: out.departTime ?? null, fromAirport: out.originAirport ?? null,
    });
  }
  for (let i = 0; i + 1 < cities.length; i++) {
    const a = cities[i];
    const t = a.transportOut;
    if (!t) continue;
    legs.push({
      id: `${a.name}→${cities[i + 1].name}`, kind: 'intercity', from: a.name, to: cities[i + 1].name,
      departCity: a.name, departCountry: a.country ?? null, mode: modeOf(t.mode), operator: t.operator ?? null,
      departDate: t.departDate ?? a.dates?.departure ?? null, departTime: t.departTime ?? null, fromAirport: null,
    });
  }
  const ret = trip?.origin?.returnLeg;
  const last = cities[cities.length - 1];
  if (home && ret && trip?.returnToHome !== false) {
    legs.push({
      id: `${last.name}→home`, kind: 'return', from: last.name, to: trip.origin.returnCity || home,
      departCity: last.name, departCountry: last.country ?? null, mode: 'flight', operator: ret.operator ?? null,
      departDate: ret.departDate ?? last.dates?.departure ?? null, departTime: ret.departTime ?? null,
      fromAirport: ret.originAirport ?? null,
    });
  }
  return legs;
}

/** The last day of the trip (YYYY-MM-DD): return flight, else last departure. */
function tripEndDate(trip: any, legs: NudgeLeg[]): string | null {
  const ret = legs.find((l) => l.kind === 'return');
  const cities: any[] = trip?.cities ?? [];
  return ret?.departDate ?? cities[cities.length - 1]?.dates?.departure ?? null;
}

function tripStartDate(trip: any, legs: NudgeLeg[]): string | null {
  return legs[0]?.departDate ?? trip?.cities?.[0]?.dates?.arrival ?? null;
}

/** Where the travellers' clock is at `now`: home before departure, then the city of the day. */
export function currentTimeZone(trip: any, legs: NudgeLeg[], now: number): string | null {
  const homeTz = timeZoneForCity(trip?.origin?.city);
  const first = legs[0];
  if (first?.departDate && first.departTime) {
    const tz = timeZoneForCity(first.departCity, first.departCountry);
    const dep = tz ? zonedToUtc(first.departDate, first.departTime, tz) : null;
    if (dep !== null && now < dep) return homeTz ?? tz;
  }
  // During the trip: the city whose stay covers today (UTC date is close enough
  // for choosing a city); on a travel day the departure city's clock applies.
  const today = new Date(now).toISOString().slice(0, 10);
  const cities: any[] = trip?.cities ?? [];
  for (const c of cities) {
    const a = c?.dates?.arrival;
    const d = c?.dates?.departure;
    if (a && d && a <= today && today <= d) return timeZoneForCity(c.name, c.country);
  }
  if (cities.length && today < (cities[0]?.dates?.arrival ?? '')) return homeTz;
  return homeTz;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function modeWord(m: LegMode): string {
  return m === 'other' ? 'trip' : m;
}

function hhmm(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// ─── rules (pure) ───────────────────────────────────────────────────────

export async function candidateNudges(
  tripId: string,
  trip: any,
  now: number,
  bookings: BookingLookup,
  cfg: NudgeConfig = DEFAULT_NUDGE_CONFIG,
): Promise<Nudge[]> {
  const legs = legsForNudges(trip);
  const link = `${cfg.siteUrl.replace(/\/$/, '')}/results?tripId=${encodeURIComponent(tripId)}`;
  const out: Nudge[] = [];
  for (const leg of legs) {
    if (!leg.departDate) continue;
    const booked = await bookings.isBooked(tripId, leg);
    const tz = timeZoneForCity(leg.departCity, leg.departCountry);
    const departAt = tz && leg.departTime ? zonedToUtc(leg.departDate, leg.departTime, tz) : null;

    // Unbooked leg, departing within N days (and not yet departed).
    if (!booked) {
      const dayStart = Date.parse(`${leg.departDate}T00:00:00Z`);
      const daysAway = (dayStart - now) / DAY;
      const stillAhead = departAt !== null ? departAt > now : dayStart + DAY > now;
      if (stillAhead && daysAway <= cfg.unbookedWithinDays) {
        out.push({
          key: `unbooked:${leg.id}:${leg.departDate}`,
          kind: 'unbooked_leg',
          urgency: 40,
          text:
            `Heads up: your ${leg.from} → ${leg.to} ${modeWord(leg.mode)} on ${shortDate(leg.departDate)}` +
            `${leg.departTime ? ` (${leg.departTime})` : ''} isn't booked yet. Book it here: ${link}`,
          expiresAt: departAt ?? dayStart + DAY,
        });
      }
    }

    // Leave now: only with a real departure time in a known zone.
    if (departAt !== null && tz && (booked || cfg.leaveNowForUnbooked)) {
      const leaveAt = departAt - cfg.leaveBufferMin[leg.mode] * MIN;
      if (now >= leaveAt - 20 * MIN && now <= leaveAt + 15 * MIN) {
        const where = leg.mode === 'flight' ? (leg.fromAirport ? `${leg.fromAirport} airport` : 'the airport') : 'the station';
        out.push({
          key: `leave:${leg.id}:${leg.departDate}`,
          kind: 'leave_now',
          urgency: 100,
          text:
            `Time to head to ${where}: your ${leg.operator ? `${leg.operator} ` : ''}${modeWord(leg.mode)} to ${leg.to} ` +
            `leaves at ${leg.departTime}. Leave by ${hhmm(leaveAt, tz)} to be safe.`,
          expiresAt: leaveAt + 15 * MIN,
        });
      }
    }
  }
  return out.sort((a, b) => b.urgency - a.urgency);
}

// ─── engine ─────────────────────────────────────────────────────────────

export type NudgeOutcome = {
  tripId: string;
  threadKey?: string;
  key?: string;
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
};

export class NudgeEngine {
  private running = false;
  private cfg: NudgeConfig;

  constructor(
    private deps: {
      store: TextStore;
      trips: TripLoader;
      provider: TextProvider;
      bookings: BookingLookup;
      config?: Partial<NudgeConfig>;
    },
  ) {
    this.cfg = { ...DEFAULT_NUDGE_CONFIG, ...(deps.config ?? {}) };
  }

  /** One pass over every linked trip. Never overlaps itself in this process. */
  async runOnce(now = Date.now()): Promise<NudgeOutcome[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const threads = await this.deps.store.listThreads();
      const byTrip = new Map<string, ThreadLink[]>();
      for (const t of threads) byTrip.set(t.tripId, [...(byTrip.get(t.tripId) ?? []), t]);
      const out: NudgeOutcome[] = [];
      for (const [tripId, ts] of byTrip) {
        try {
          out.push(await this.runTrip(tripId, ts, now));
        } catch (err: any) {
          logger.warn('nudge run failed for trip', { tripId, message: err?.message });
          out.push({ tripId, status: 'failed', reason: 'error' });
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  private async runTrip(tripId: string, threads: ThreadLink[], now: number): Promise<NudgeOutcome> {
    const { store, trips } = this.deps;
    const loaded = await trips.load(tripId);
    if (!loaded) return { tripId, status: 'skipped', reason: 'trip not found' };
    const trip: any = loaded.trip;
    const legs = legsForNudges(trip);

    const end = tripEndDate(trip, legs);
    if (end && now > Date.parse(`${end}T23:59:59Z`) + DAY) return { tripId, status: 'skipped', reason: 'trip over' };

    const tz = currentTimeZone(trip, legs, now);
    if (!tz) return { tripId, status: 'skipped', reason: 'unknown time zone' };
    const local = localParts(now, tz);
    if (local.hour >= this.cfg.quietStartHour || local.hour < this.cfg.quietEndHour) {
      return { tripId, status: 'skipped', reason: 'quiet hours' };
    }

    // Budget per trip per local day.
    const start = tripStartDate(trip, legs);
    const travelling = !!start && local.date >= start;
    const cap = travelling ? this.cfg.maxPerDayTravelling : this.cfg.maxPerDayBefore;
    if ((await store.sentNudgesOn(tripId, local.date)) >= cap) {
      return { tripId, status: 'skipped', reason: 'daily budget used' };
    }

    // One channel per trip: the biggest eligible thread (the group) first.
    const members = await trips.members(tripId);
    const eligible: Array<{ t: ThreadLink; key: string }> = [];
    for (const t of threads) {
      const key = store.threadKey(t.provider, t.providerThreadId);
      if (await this.threadBlocked(key, members, now)) continue;
      eligible.push({ t, key });
    }
    if (!eligible.length) return { tripId, status: 'skipped', reason: 'no thread may receive it' };
    const sizes = await Promise.all(eligible.map((e) => store.participants(e.key)));
    const pick = eligible
      .map((e, i) => ({ ...e, size: sizes[i].length }))
      .sort((a, b) => b.size - a.size)[0];

    const candidates = await candidateNudges(tripId, trip, now, this.deps.bookings, this.cfg);
    const tooSoon = now - (await store.lastNudgeAt(tripId)) < this.cfg.minGapMin * MIN;
    for (const n of candidates) {
      if (now > n.expiresAt) continue;
      if (tooSoon && n.kind !== 'leave_now') continue;
      // Claim first: unique per (trip, key). False = already sent or in flight.
      if (!(await store.claimNudge(tripId, n.key, pick.key, local.date, now))) continue;
      try {
        await this.deps.provider.send({ provider: pick.t.provider, threadId: pick.t.providerThreadId, text: n.text });
        await store.markNudge(tripId, n.key, 'sent');
        return { tripId, threadKey: pick.key, key: n.key, status: 'sent' };
      } catch (err: any) {
        await store.markNudge(tripId, n.key, 'failed');
        logger.warn('nudge send failed', { tripId, key: n.key, message: err?.message });
        return { tripId, threadKey: pick.key, key: n.key, status: 'failed', reason: 'send failed' };
      }
    }
    return {
      tripId,
      status: 'skipped',
      reason: !candidates.length ? 'nothing to say' : tooSoon ? 'too soon after the last nudge' : 'already sent',
    };
  }

  /**
   * Outbound privacy + consent re-check, from the thread's latest participant
   * snapshot: everyone must still be a verified member of THIS trip, none
   * opted out, every one consented to proactive texts, and the thread not muted.
   */
  private async threadBlocked(threadKey: string, members: Map<string, unknown>, now: number): Promise<string | null> {
    const { store } = this.deps;
    if ((await store.mutedUntil(threadKey)) > now) return 'muted';
    const people = await store.participants(threadKey);
    if (!people.length) return 'no snapshot';
    for (const p of people) {
      const link = await store.userForPhone(p);
      if (!link || !members.has(link.userId)) return `outsider ${maskPhone(p)}`;
      if (await store.isOptedOut(p)) return 'opted out';
      if (!(await store.hasProactiveConsent(p))) return 'no consent';
    }
    return null;
  }
}
