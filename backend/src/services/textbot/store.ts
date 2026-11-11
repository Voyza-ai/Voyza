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
  expiresAt: number;
};

export interface TextStore {
  threadKey(provider: ProviderName, providerThreadId: string): string;
  getThread(provider: ProviderName, providerThreadId: string): Promise<ThreadLink | null>;
  linkThread(l: Omit<ThreadLink, 'id' | 'linkedAt'>): Promise<ThreadLink>;
  unlinkThread(provider: ProviderName, providerThreadId: string): Promise<void>;

  userForPhone(phone: Phone): Promise<PhoneLink | null>;
  linkPhone(userId: string, phone: Phone): Promise<void>;

  createCode(kind: LinkCode['kind'], tripId: string, userId: string, ttlMs?: number): Promise<LinkCode>;
  /** Single use: returns the code and marks it used, or null if absent/expired/used. */
  consumeCode(code: string, now?: number): Promise<LinkCode | null>;

  /** True the first time a provider message id is seen (dedupe redeliveries). */
  markSeen(provider: ProviderName, providerMessageId: string): Promise<boolean>;

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
    // One phone → one user. A phone moving accounts replaces the old link.
    this.phones.set(phone, { userId, phone, verifiedAt: new Date().toISOString() });
  }

  async createCode(kind: LinkCode['kind'], tripId: string, userId: string, ttlMs = CODE_TTL_MS) {
    let code = newCode();
    while (this.codes.has(code)) code = newCode();
    const row: LinkCode = { code, kind, tripId, userId, expiresAt: Date.now() + ttlMs, usedAt: null };
    this.codes.set(code, row);
    return row;
  }
  async consumeCode(code: string, now = Date.now()) {
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

  async history(threadKey: string) {
    return [...(this.hist.get(threadKey) ?? [])];
  }
  async appendHistory(threadKey: string, turn: ChatTurn) {
    const h = this.hist.get(threadKey) ?? [];
    h.push(turn);
    this.hist.set(threadKey, h.slice(-HISTORY_TURNS));
  }

  async getPending(threadKey: string, now = Date.now()) {
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
