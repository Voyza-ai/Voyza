import { randomBytes, randomUUID } from 'crypto';
import type { ChatResult, ChatTurn, Phone, ProviderName } from './types';

/**
 * State for the group-text assistant.
 *
 * Mirrors migration 016_text_threads.sql (NOT APPLIED). Until the owner OKs
 * that migration, MemoryTextStore is the only implementation: state lives in
 * process memory and is lost on restart, exactly like bookingStore.ts's
 * fallback. A Supabase-backed store implements the same interface later.
 */

export type MemberRole = 'owner' | 'editor' | 'viewer';

export type ThreadLink = {
  id: string;
  provider: ProviderName;
  providerThreadId: string;
  tripId: string;
  linkedByUserId: string;
  linkedAt: string;
};

export type PhoneLink = { userId: string; phone: Phone; verifiedAt: string };

/** One-time code made in the app. kind=link binds a thread to a trip AND the
 *  sender's phone to the user; kind=verify binds only the phone. */
export type LinkCode = {
  code: string;
  kind: 'link' | 'verify';
  tripId: string;
  userId: string;
  expiresAt: number;
  usedAt: number | null;
};

export type PendingEdit = {
  id: string;
  threadKey: string;
  tripId: string;
  requestedByUserId: string;
  result: ChatResult;
  summary: string;
  /** trips.updated_at when proposed; the applier refuses if it moved. */
  tripUpdatedAt: string | null;
  expiresAt: number;
};

export interface TextStore {
  threadKey(provider: ProviderName, providerThreadId: string): string;
  getThread(provider: ProviderName, providerThreadId: string): Promise<ThreadLink | null>;
  linkThread(l: Omit<ThreadLink, 'id' | 'linkedAt'>): Promise<ThreadLink>;
  unlinkThread(provider: ProviderName, providerThreadId: string): Promise<void>;

  userForPhone(phone: Phone): Promise<PhoneLink | null>;
  linkPhone(userId: string, phone: Phone): Promise<void>;
  phoneForUser(userId: string): Promise<PhoneLink | null>;
  unlinkPhone(userId: string): Promise<void>;

  createCode(kind: LinkCode['kind'], tripId: string, userId: string, ttlMs?: number): Promise<LinkCode>;
  /** Single use: returns the code and marks it used, or null if absent/expired/used. */
  consumeCode(code: string, now?: number): Promise<LinkCode | null>;

  /** True the first time a provider message id is seen (dedupe redeliveries). */
  markSeen(provider: ProviderName, providerMessageId: string): Promise<boolean>;

  /** Carrier-style opt-out (STOP). An opted-out phone gets no texts at all. */
  setOptedOut(phone: Phone, optedOut: boolean): Promise<void>;
  isOptedOut(phone: Phone): Promise<boolean>;
  /** Separate, explicit consent for Blue to text FIRST (proactive nudges). */
  setProactiveConsent(phone: Phone, on: boolean): Promise<void>;
  hasProactiveConsent(phone: Phone): Promise<boolean>;
  /** Who was in the thread at its latest inbound message (bot excluded). */
  setParticipants(threadKey: string, phones: Phone[]): Promise<void>;
  participants(threadKey: string): Promise<Phone[]>;

  /** Every linked thread (for the nudge engine). */
  listThreads(): Promise<ThreadLink[]>;
  /** Mute proactive nudges in a thread until `untilMs` (0 = unmuted). */
  setMutedUntil(threadKey: string, untilMs: number): Promise<void>;
  mutedUntil(threadKey: string): Promise<number>;
  /**
   * Nudge ledger, claim-first: returns true only for the FIRST claim of
   * (tripId, key). A later claim — a re-run, a restart, a second worker —
   * returns false whatever the first one's status, so a nudge is never sent twice.
   */
  claimNudge(tripId: string, key: string, threadKey: string, localDay: string, now: number): Promise<boolean>;
  markNudge(tripId: string, key: string, status: 'sent' | 'failed'): Promise<void>;
  /** Nudges marked sent for a trip on a local day (YYYY-MM-DD). */
  sentNudgesOn(tripId: string, localDay: string): Promise<number>;
  /** Legs a traveller said are booked elsewhere ("BlueMurr booked"). */
  markLegBooked(tripId: string, legId: string): Promise<void>;
  legsMarkedBooked(tripId: string): Promise<Set<string>>;
  /** The newest unbooked-leg nudge's leg id for a trip, if any. */
  lastUnbookedNudgeLeg(tripId: string): Promise<string | null>;
  /** When the last nudge for a trip was claimed (0 = never). */
  lastNudgeAt(tripId: string): Promise<number>;

  history(threadKey: string): Promise<ChatTurn[]>;
  appendHistory(threadKey: string, turn: ChatTurn): Promise<void>;

  getPending(threadKey: string, now?: number): Promise<PendingEdit | null>;
  setPending(p: Omit<PendingEdit, 'id'>): Promise<PendingEdit>;
  clearPending(threadKey: string): Promise<void>;
}

/** No 0/O/1/I/L — codes get read off a screen and typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(len = 6): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

const HISTORY_TURNS = 12;
export const CODE_TTL_MS = 15 * 60_000;

export class MemoryTextStore implements TextStore {
  private threads = new Map<string, ThreadLink>();
  private phones = new Map<Phone, PhoneLink>();
  private codes = new Map<string, LinkCode>();
  private seen = new Set<string>();
  private hist = new Map<string, ChatTurn[]>();
  private pending = new Map<string, PendingEdit>();
  private optedOut = new Set<Phone>();
  private consent = new Set<Phone>();
  private members = new Map<string, Phone[]>();
  private muted = new Map<string, number>();
  private bookedElsewhere = new Map<string, Set<string>>();
  private ledger = new Map<string, { threadKey: string; localDay: string; status: 'pending' | 'sent' | 'failed'; at: number }>();

  /** Clock is injectable so tests and the bot agree on "now". */
  constructor(private clock: () => number = () => Date.now()) {}

  threadKey(provider: ProviderName, providerThreadId: string) {
    return `${provider}:${providerThreadId}`;
  }
  async getThread(p: ProviderName, t: string) {
    return this.threads.get(this.threadKey(p, t)) ?? null;
  }
  async linkThread(l: Omit<ThreadLink, 'id' | 'linkedAt'>) {
    const row: ThreadLink = { ...l, id: randomUUID(), linkedAt: new Date().toISOString() };
    const key = this.threadKey(l.provider, l.providerThreadId);
    this.threads.set(key, row);
    // Re-linking to another trip must not carry the old trip's chat or edit.
    this.hist.delete(key);
    this.pending.delete(key);
    return row;
  }
  async unlinkThread(p: ProviderName, t: string) {
    const key = this.threadKey(p, t);
    this.threads.delete(key);
    this.hist.delete(key);
    this.pending.delete(key);
  }

  async userForPhone(phone: Phone) {
    return this.phones.get(phone) ?? null;
  }
  async linkPhone(userId: string, phone: Phone) {
    // One phone → one user, one user → one phone (migration 016's two unique
    // keys). A phone moving accounts, or a user changing number, replaces
    // the old link rather than leaving a second one behind.
    for (const [p, l] of this.phones) if (l.userId === userId) this.phones.delete(p);
    this.phones.set(phone, { userId, phone, verifiedAt: new Date(this.clock()).toISOString() });
  }
  async phoneForUser(userId: string) {
    for (const l of this.phones.values()) if (l.userId === userId) return l;
    return null;
  }
  async unlinkPhone(userId: string) {
    for (const [p, l] of this.phones) if (l.userId === userId) this.phones.delete(p);
  }

  async createCode(kind: LinkCode['kind'], tripId: string, userId: string, ttlMs = CODE_TTL_MS) {
    let code = newCode();
    while (this.codes.has(code)) code = newCode();
    const row: LinkCode = { code, kind, tripId, userId, expiresAt: this.clock() + ttlMs, usedAt: null };
    this.codes.set(code, row);
    return row;
  }
  async consumeCode(code: string, now = this.clock()) {
    const row = this.codes.get(code.toUpperCase());
    if (!row || row.usedAt !== null || row.expiresAt <= now) return null;
    row.usedAt = now;
    return { ...row };
  }

  async markSeen(provider: ProviderName, id: string) {
    const key = `${provider}:${id}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 50_000) this.seen.clear(); // bounded; dedupe is best-effort
    return true;
  }

  async setOptedOut(phone: Phone, v: boolean) {
    if (v) {
      this.optedOut.add(phone);
      this.consent.delete(phone); // STOP also withdraws consent to be texted first
    } else this.optedOut.delete(phone);
  }
  async isOptedOut(phone: Phone) {
    return this.optedOut.has(phone);
  }
  async setProactiveConsent(phone: Phone, on: boolean) {
    if (on) this.consent.add(phone);
    else this.consent.delete(phone);
  }
  async hasProactiveConsent(phone: Phone) {
    return this.consent.has(phone) && !this.optedOut.has(phone);
  }
  async setParticipants(threadKey: string, phones: Phone[]) {
    this.members.set(threadKey, [...new Set(phones)].sort());
  }
  async participants(threadKey: string) {
    return [...(this.members.get(threadKey) ?? [])];
  }

  async listThreads() {
    return [...this.threads.values()];
  }
  async setMutedUntil(threadKey: string, untilMs: number) {
    if (untilMs > 0) this.muted.set(threadKey, untilMs);
    else this.muted.delete(threadKey);
  }
  async mutedUntil(threadKey: string) {
    return this.muted.get(threadKey) ?? 0;
  }
  async claimNudge(tripId: string, key: string, threadKey: string, localDay: string, now: number) {
    const k = `${tripId}|${key}`;
    if (this.ledger.has(k)) return false;
    this.ledger.set(k, { threadKey, localDay, status: 'pending', at: now });
    return true;
  }
  async markNudge(tripId: string, key: string, status: 'sent' | 'failed') {
    const row = this.ledger.get(`${tripId}|${key}`);
    if (row) row.status = status;
  }
  async markLegBooked(tripId: string, legId: string) {
    const set = this.bookedElsewhere.get(tripId) ?? new Set<string>();
    set.add(legId);
    this.bookedElsewhere.set(tripId, set);
  }
  async legsMarkedBooked(tripId: string) {
    return new Set(this.bookedElsewhere.get(tripId) ?? []);
  }
  async lastUnbookedNudgeLeg(tripId: string) {
    let best: { at: number; leg: string } | null = null;
    for (const [k, v] of this.ledger) {
      const m = k.match(/^([^|]+)\|unbooked:(.+):\d{4}-\d{2}-\d{2}$/);
      if (m && m[1] === tripId && v.status === 'sent' && (!best || v.at >= best.at)) best = { at: v.at, leg: m[2] };
    }
    return best?.leg ?? null;
  }
  async lastNudgeAt(tripId: string) {
    let last = 0;
    for (const [k, v] of this.ledger) if (k.startsWith(`${tripId}|`) && v.status !== 'failed' && v.at > last) last = v.at;
    return last;
  }
  async sentNudgesOn(tripId: string, localDay: string) {
    let n = 0;
    for (const [k, v] of this.ledger) if (k.startsWith(`${tripId}|`) && v.localDay === localDay && v.status === 'sent') n++;
    return n;
  }

  async history(threadKey: string) {
    return [...(this.hist.get(threadKey) ?? [])];
  }
  async appendHistory(threadKey: string, turn: ChatTurn) {
    const h = this.hist.get(threadKey) ?? [];
    h.push(turn);
    this.hist.set(threadKey, h.slice(-HISTORY_TURNS));
  }

  async getPending(threadKey: string, now = this.clock()) {
    const p = this.pending.get(threadKey);
    if (!p) return null;
    if (p.expiresAt <= now) {
      this.pending.delete(threadKey);
      return null;
    }
    return p;
  }
  async setPending(p: Omit<PendingEdit, 'id'>) {
    const row = { ...p, id: randomUUID() };
    this.pending.set(p.threadKey, row); // one open edit per thread; newest wins
    return row;
  }
  async clearPending(threadKey: string) {
    this.pending.delete(threadKey);
  }
}
