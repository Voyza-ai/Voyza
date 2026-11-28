import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../supabase';
import { CODE_TTL_MS, MemoryTextStore, newCode, type LinkCode, type PendingEdit, type PhoneLink, type TextStore, type ThreadLink } from './store';
import type { ChatTurn, Phone, ProviderName } from './types';

/**
 * Durable TextStore on migration 016 (applied 2026-11-28):
 *   user_phones, text_threads (+ participants, muted_until, history),
 *   text_link_codes, text_phone_prefs, blue_nudges, text_legs_booked.
 *
 * Still in memory (by design, see the migration header): delivery dedupe
 * (markSeen) and pending YES/NO edits — both short-lived.
 *
 * Race-safety lives in single SQL statements, proven in the 016 rehearsal:
 *   - consumeCode: UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING
 *   - claimNudge:  INSERT … ON CONFLICT (trip_id, nudge_key) DO NOTHING RETURNING
 * Every DB error throws; the bot turns it into a short apology and the
 * nudge engine skips the trip, so nothing is sent on a failed write.
 */
const HISTORY_TURNS = 12;

export class SupabaseTextStore implements TextStore {
  private mem: MemoryTextStore; // markSeen + pending edits only
  constructor(
    private db: SupabaseClient = getSupabase(),
    private clock: () => number = () => Date.now(),
  ) {
    this.mem = new MemoryTextStore(clock);
  }

  private iso(ms = this.clock()) {
    return new Date(ms).toISOString();
  }

  private check<T>(r: { data: T; error: any }, op: string): T {
    if (r.error) throw new Error(`textbot store ${op}: ${r.error.message ?? r.error.code ?? 'error'}`);
    return r.data;
  }

  threadKey(provider: ProviderName, providerThreadId: string) {
    return `${provider}:${providerThreadId}`;
  }

  private splitKey(threadKey: string): [ProviderName, string] {
    const i = threadKey.indexOf(':');
    return [threadKey.slice(0, i) as ProviderName, threadKey.slice(i + 1)];
  }

  private toThread(r: any): ThreadLink {
    return {
      id: r.id,
      provider: r.provider,
      providerThreadId: r.provider_thread_id,
      tripId: r.trip_id,
      linkedByUserId: r.linked_by,
      linkedAt: r.linked_at,
    };
  }

  private async threadRow(threadKey: string, cols = '*'): Promise<any | null> {
    const [p, t] = this.splitKey(threadKey);
    return this.check(
      await this.db.from('text_threads').select(cols).eq('provider', p).eq('provider_thread_id', t).maybeSingle(),
      'thread',
    );
  }

  async getThread(provider: ProviderName, providerThreadId: string) {
    const r = await this.threadRow(this.threadKey(provider, providerThreadId));
    return r ? this.toThread(r) : null;
  }

  async linkThread(l: Omit<ThreadLink, 'id' | 'linkedAt'>) {
    const row = this.check(
      await this.db
        .from('text_threads')
        .upsert(
          {
            provider: l.provider,
            provider_thread_id: l.providerThreadId,
            trip_id: l.tripId,
            linked_by: l.linkedByUserId,
            linked_at: this.iso(),
            history: [], // re-linking to another trip must not carry the old trip's chat
          },
          { onConflict: 'provider,provider_thread_id' },
        )
        .select()
        .single(),
      'linkThread',
    );
    await this.mem.clearPending(this.threadKey(l.provider, l.providerThreadId));
    return this.toThread(row);
  }

  async unlinkThread(provider: ProviderName, providerThreadId: string) {
    this.check(
      await this.db.from('text_threads').delete().eq('provider', provider).eq('provider_thread_id', providerThreadId),
      'unlinkThread',
    );
    await this.mem.clearPending(this.threadKey(provider, providerThreadId));
  }

  async listThreads() {
    const rows = this.check(await this.db.from('text_threads').select('*'), 'listThreads') as any[];
    return (rows ?? []).map((r) => this.toThread(r));
  }

  // ─── phones ────────────────────────────────────────────────────────────

  async userForPhone(phone: Phone): Promise<PhoneLink | null> {
    const r: any = this.check(
      await this.db.from('user_phones').select('*').eq('phone_e164', phone).maybeSingle(),
      'userForPhone',
    );
    return r ? { userId: r.user_id, phone: r.phone_e164, verifiedAt: r.verified_at } : null;
  }

  async phoneForUser(userId: string): Promise<PhoneLink | null> {
    const r: any = this.check(
      await this.db.from('user_phones').select('*').eq('user_id', userId).maybeSingle(),
      'phoneForUser',
    );
    return r ? { userId: r.user_id, phone: r.phone_e164, verifiedAt: r.verified_at } : null;
  }

  async linkPhone(userId: string, phone: Phone) {
    // A phone moving accounts: drop the old owner's row for this phone first,
    // then upsert this user's (one phone per user) — rehearsal probe 5.
    this.check(await this.db.from('user_phones').delete().eq('phone_e164', phone).neq('user_id', userId), 'linkPhone.move');
    this.check(
      await this.db
        .from('user_phones')
        .upsert({ user_id: userId, phone_e164: phone, verified_at: this.iso() }, { onConflict: 'user_id' }),
      'linkPhone',
    );
  }

  async unlinkPhone(userId: string) {
    this.check(await this.db.from('user_phones').delete().eq('user_id', userId), 'unlinkPhone');
  }

  // ─── codes ─────────────────────────────────────────────────────────────

  async createCode(kind: LinkCode['kind'], tripId: string, userId: string, ttlMs = CODE_TTL_MS): Promise<LinkCode> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const now = this.clock();
      const r = await this.db.from('text_link_codes').insert({
        code,
        kind,
        trip_id: tripId,
        user_id: userId,
        created_at: this.iso(now),
        expires_at: this.iso(now + ttlMs),
      });
      if (!r.error) return { code, kind, tripId, userId, expiresAt: now + ttlMs, usedAt: null };
      if (r.error.code !== '23505') this.check(r, 'createCode'); // not a collision: throw
    }
    throw new Error('textbot store createCode: could not find a free code');
  }

  async consumeCode(code: string, now = this.clock()): Promise<LinkCode | null> {
    const rows = this.check(
      await this.db
        .from('text_link_codes')
        .update({ used_at: this.iso(now) })
        .eq('code', code.toUpperCase())
        .is('used_at', null)
        .gt('expires_at', this.iso(now))
        .select(),
      'consumeCode',
    ) as any[];
    const r = rows?.[0];
    return r
      ? { code: r.code, kind: r.kind, tripId: r.trip_id, userId: r.user_id, expiresAt: Date.parse(r.expires_at), usedAt: now }
      : null;
  }

  // ─── in memory on purpose ──────────────────────────────────────────────

  markSeen(provider: ProviderName, id: string) {
    return this.mem.markSeen(provider, id);
  }
  getPending(threadKey: string, now?: number) {
    return this.mem.getPending(threadKey, now);
  }
  setPending(p: Omit<PendingEdit, 'id'>) {
    return this.mem.setPending(p);
  }
  clearPending(threadKey: string) {
    return this.mem.clearPending(threadKey);
  }

  // ─── STOP / consent (per phone) ────────────────────────────────────────

  private async pref(phone: Phone): Promise<any | null> {
    return this.check(await this.db.from('text_phone_prefs').select('*').eq('phone_e164', phone).maybeSingle(), 'pref');
  }

  async setOptedOut(phone: Phone, optedOut: boolean) {
    const patch: any = { phone_e164: phone, opted_out_at: optedOut ? this.iso() : null, updated_at: this.iso() };
    if (optedOut) patch.proactive_consent_at = null; // STOP also withdraws consent to be texted first
    this.check(await this.db.from('text_phone_prefs').upsert(patch, { onConflict: 'phone_e164' }), 'setOptedOut');
  }

  async isOptedOut(phone: Phone) {
    return !!(await this.pref(phone))?.opted_out_at;
  }

  async setProactiveConsent(phone: Phone, on: boolean) {
    this.check(
      await this.db
        .from('text_phone_prefs')
        .upsert({ phone_e164: phone, proactive_consent_at: on ? this.iso() : null, updated_at: this.iso() }, { onConflict: 'phone_e164' }),
      'setProactiveConsent',
    );
  }

  async hasProactiveConsent(phone: Phone) {
    const p = await this.pref(phone);
    return !!p?.proactive_consent_at && !p?.opted_out_at;
  }

  // ─── thread state ──────────────────────────────────────────────────────

  async setParticipants(threadKey: string, phones: Phone[]) {
    const [p, t] = this.splitKey(threadKey);
    // Only linked threads have a row; for unlinked ones the snapshot isn't needed.
    this.check(
      await this.db
        .from('text_threads')
        .update({ participants: [...new Set(phones)].sort() })
        .eq('provider', p)
        .eq('provider_thread_id', t),
      'setParticipants',
    );
  }

  async participants(threadKey: string) {
    const r = await this.threadRow(threadKey, 'participants');
    return [...((r?.participants as string[]) ?? [])];
  }

  async setMutedUntil(threadKey: string, untilMs: number) {
    const [p, t] = this.splitKey(threadKey);
    this.check(
      await this.db
        .from('text_threads')
        .update({ muted_until: untilMs > 0 ? this.iso(untilMs) : null })
        .eq('provider', p)
        .eq('provider_thread_id', t),
      'setMutedUntil',
    );
  }

  async mutedUntil(threadKey: string) {
    const r = await this.threadRow(threadKey, 'muted_until');
    return r?.muted_until ? Date.parse(r.muted_until) : 0;
  }

  async history(threadKey: string): Promise<ChatTurn[]> {
    const r = await this.threadRow(threadKey, 'history');
    return Array.isArray(r?.history) ? (r.history as ChatTurn[]) : [];
  }

  async appendHistory(threadKey: string, turn: ChatTurn) {
    // Read-modify-write is safe: the bot handles one message per thread at a time.
    const [p, t] = this.splitKey(threadKey);
    const next = [...(await this.history(threadKey)), turn].slice(-HISTORY_TURNS);
    this.check(
      await this.db.from('text_threads').update({ history: next }).eq('provider', p).eq('provider_thread_id', t),
      'appendHistory',
    );
  }

  // ─── nudge ledger ──────────────────────────────────────────────────────

  async claimNudge(tripId: string, key: string, threadKey: string, localDay: string, now: number) {
    const thread = await this.threadRow(threadKey, 'id');
    const rows = this.check(
      await this.db
        .from('blue_nudges')
        .upsert(
          { trip_id: tripId, nudge_key: key, thread_id: thread?.id ?? null, local_day: localDay, status: 'pending', claimed_at: this.iso(now) },
          { onConflict: 'trip_id,nudge_key', ignoreDuplicates: true },
        )
        .select(),
      'claimNudge',
    ) as any[];
    return (rows?.length ?? 0) > 0;
  }

  async markNudge(tripId: string, key: string, status: 'sent' | 'failed') {
    this.check(
      await this.db.from('blue_nudges').update({ status }).eq('trip_id', tripId).eq('nudge_key', key),
      'markNudge',
    );
  }

  async sentNudgesOn(tripId: string, localDay: string) {
    const r = await this.db
      .from('blue_nudges')
      .select('nudge_key', { count: 'exact', head: true })
      .eq('trip_id', tripId)
      .eq('local_day', localDay)
      .eq('status', 'sent');
    this.check(r as any, 'sentNudgesOn');
    return r.count ?? 0;
  }

  async lastNudgeAt(tripId: string) {
    const rows = this.check(
      await this.db
        .from('blue_nudges')
        .select('claimed_at')
        .eq('trip_id', tripId)
        .neq('status', 'failed')
        .order('claimed_at', { ascending: false })
        .limit(1),
      'lastNudgeAt',
    ) as any[];
    return rows?.[0]?.claimed_at ? Date.parse(rows[0].claimed_at) : 0;
  }

  async lastUnbookedNudgeLeg(tripId: string) {
    const rows = this.check(
      await this.db
        .from('blue_nudges')
        .select('nudge_key')
        .eq('trip_id', tripId)
        .eq('status', 'sent')
        .like('nudge_key', 'unbooked:%')
        .order('claimed_at', { ascending: false })
        .limit(1),
      'lastUnbookedNudgeLeg',
    ) as any[];
    const m = String(rows?.[0]?.nudge_key ?? '').match(/^unbooked:(.+):\d{4}-\d{2}-\d{2}$/);
    return m ? m[1] : null;
  }

  async markLegBooked(tripId: string, legId: string) {
    this.check(
      await this.db
        .from('text_legs_booked')
        .upsert({ trip_id: tripId, leg_id: legId, marked_at: this.iso() }, { onConflict: 'trip_id,leg_id', ignoreDuplicates: true }),
      'markLegBooked',
    );
  }

  async legsMarkedBooked(tripId: string) {
    const rows = this.check(await this.db.from('text_legs_booked').select('leg_id').eq('trip_id', tripId), 'legsMarkedBooked') as any[];
    return new Set((rows ?? []).map((r) => String(r.leg_id)));
  }
}
