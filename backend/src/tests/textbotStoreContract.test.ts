/**
 * TextStore contract: the in-memory store and the durable Supabase store
 * (services/textbot/supabaseStore.ts, on a fake client) must behave the same.
 * The SQL-level guarantees (single-use codes, claim-once nudges) are also
 * proven on the real project by the 016 rehearsal (probes 10–11, 32–33).
 */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } }));
import { MemoryTextStore, type TextStore } from '../services/textbot/store';
import { SupabaseTextStore } from '../services/textbot/supabaseStore';
import { FakeSupabase } from './helpers/fakeSupabase';

const T0 = Date.parse('2027-05-20T08:00:00Z');

const impls: Array<[string, (clock: () => number) => { store: TextStore; fake?: FakeSupabase }]> = [
  ['memory', (clock) => ({ store: new MemoryTextStore(clock) })],
  ['supabase', (clock) => { const fake = new FakeSupabase(); return { store: new SupabaseTextStore(fake as any, clock), fake }; }],
];

describe.each(impls)('TextStore contract: %s', (_name, make) => {
  let now = T0;
  let store: TextStore;
  beforeEach(() => { now = T0; ({ store } = make(() => now)); });

  it('links a thread, re-links to another trip (history cleared), unlinks', async () => {
    const t = await store.linkThread({ provider: 'twilio', providerThreadId: 'conv:CH1', tripId: 'trip-a', linkedByUserId: 'u1' });
    expect(t.tripId).toBe('trip-a');
    await store.appendHistory('twilio:conv:CH1', { role: 'user', content: 'hi' });
    expect(await store.history('twilio:conv:CH1')).toEqual([{ role: 'user', content: 'hi' }]);
    await store.linkThread({ provider: 'twilio', providerThreadId: 'conv:CH1', tripId: 'trip-b', linkedByUserId: 'u1' });
    expect((await store.getThread('twilio', 'conv:CH1'))?.tripId).toBe('trip-b');
    expect(await store.history('twilio:conv:CH1')).toEqual([]);
    expect((await store.listThreads()).map((x) => x.tripId)).toEqual(['trip-b']);
    await store.unlinkThread('twilio', 'conv:CH1');
    expect(await store.getThread('twilio', 'conv:CH1')).toBeNull();
  });

  it('history keeps the last 12 turns', async () => {
    await store.linkThread({ provider: 'twilio', providerThreadId: 'g', tripId: 'trip-a', linkedByUserId: 'u1' });
    for (let i = 0; i < 15; i++) await store.appendHistory('twilio:g', { role: 'user', content: `m${i}` });
    const h = await store.history('twilio:g');
    expect(h).toHaveLength(12);
    expect(h[0].content).toBe('m3');
  });

  it('phones: one per user, one user per phone; a phone can move accounts', async () => {
    await store.linkPhone('u1', '+12155550001');
    await store.linkPhone('u1', '+12155550002'); // change of number
    expect(await store.userForPhone('+12155550001')).toBeNull();
    expect((await store.phoneForUser('u1'))?.phone).toBe('+12155550002');
    await store.linkPhone('u2', '+12155550002'); // the number moves to u2
    expect((await store.userForPhone('+12155550002'))?.userId).toBe('u2');
    expect(await store.phoneForUser('u1')).toBeNull();
    await store.unlinkPhone('u2');
    expect(await store.userForPhone('+12155550002')).toBeNull();
  });

  it('codes: single use, case-insensitive, expire after their TTL', async () => {
    const c = await store.createCode('link', 'trip-a', 'u1');
    expect(c.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await store.consumeCode(c.code.toLowerCase()))?.userId).toBe('u1');
    expect(await store.consumeCode(c.code)).toBeNull();
    const d = await store.createCode('verify', 'trip-a', 'u2');
    now += 15 * 60_000 + 1;
    expect(await store.consumeCode(d.code)).toBeNull();
  });

  it('STOP / START / alerts consent per phone; STOP withdraws consent', async () => {
    const p = '+12155550001';
    expect(await store.isOptedOut(p)).toBe(false);
    await store.setProactiveConsent(p, true);
    expect(await store.hasProactiveConsent(p)).toBe(true);
    await store.setOptedOut(p, true);
    expect(await store.isOptedOut(p)).toBe(true);
    expect(await store.hasProactiveConsent(p)).toBe(false);
    await store.setOptedOut(p, false);
    expect(await store.isOptedOut(p)).toBe(false);
    expect(await store.hasProactiveConsent(p)).toBe(false); // consent must be given again
  });

  it('participants snapshot and mute live on the linked thread', async () => {
    await store.linkThread({ provider: 'twilio', providerThreadId: 'g', tripId: 'trip-a', linkedByUserId: 'u1' });
    await store.setParticipants('twilio:g', ['+12155550002', '+12155550001', '+12155550001']);
    expect(await store.participants('twilio:g')).toEqual(['+12155550001', '+12155550002']);
    expect(await store.mutedUntil('twilio:g')).toBe(0);
    await store.setMutedUntil('twilio:g', T0 + 7_200_000);
    expect(await store.mutedUntil('twilio:g')).toBe(T0 + 7_200_000);
    await store.setMutedUntil('twilio:g', 0);
    expect(await store.mutedUntil('twilio:g')).toBe(0);
  });

  it('nudge ledger: a key is claimed once (even while pending or failed); counts and last-at', async () => {
    await store.linkThread({ provider: 'twilio', providerThreadId: 'g', tripId: 'trip-a', linkedByUserId: 'u1' });
    expect(await store.claimNudge('trip-a', 'unbooked:Venice→Rome:2027-05-22', 'twilio:g', '2027-05-20', T0)).toBe(true);
    expect(await store.claimNudge('trip-a', 'unbooked:Venice→Rome:2027-05-22', 'twilio:g', '2027-05-20', T0 + 1)).toBe(false);
    expect(await store.sentNudgesOn('trip-a', '2027-05-20')).toBe(0); // still pending
    await store.markNudge('trip-a', 'unbooked:Venice→Rome:2027-05-22', 'sent');
    expect(await store.sentNudgesOn('trip-a', '2027-05-20')).toBe(1);
    expect(await store.lastNudgeAt('trip-a')).toBe(T0);
    expect(await store.lastUnbookedNudgeLeg('trip-a')).toBe('Venice→Rome');
    expect(await store.claimNudge('trip-b', 'unbooked:Venice→Rome:2027-05-22', 'twilio:g', '2027-05-20', T0)).toBe(true); // per trip
    await store.claimNudge('trip-a', 'leave:x:2027-05-20', 'twilio:g', '2027-05-20', T0 + 5);
    await store.markNudge('trip-a', 'leave:x:2027-05-20', 'failed');
    expect(await store.claimNudge('trip-a', 'leave:x:2027-05-20', 'twilio:g', '2027-05-20', T0 + 6)).toBe(false);
    expect(await store.lastNudgeAt('trip-a')).toBe(T0); // failed rows don't count
  });

  it('"booked elsewhere" marks are idempotent', async () => {
    await store.markLegBooked('trip-a', 'Venice→Rome');
    await store.markLegBooked('trip-a', 'Venice→Rome');
    expect(await store.legsMarkedBooked('trip-a')).toEqual(new Set(['Venice→Rome']));
    expect(await store.legsMarkedBooked('trip-b')).toEqual(new Set());
  });

  it('dedupe + pending edits work (kept in memory in both)', async () => {
    expect(await store.markSeen('twilio', 'IM1')).toBe(true);
    expect(await store.markSeen('twilio', 'IM1')).toBe(false);
    await store.setPending({ threadKey: 'twilio:g', tripId: 'trip-a', requestedByUserId: 'u1', result: { type: 'proposal', reply: 'x' }, summary: 'x', tripUpdatedAt: null, expiresAt: T0 + 60_000 });
    expect((await store.getPending('twilio:g'))?.summary).toBe('x');
    now += 61_000;
    expect(await store.getPending('twilio:g')).toBeNull();
  });
});

describe('SupabaseTextStore specifics', () => {
  it('a database error throws (callers then send nothing / apologise)', async () => {
    const fake = new FakeSupabase();
    const broken: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
    const s = new SupabaseTextStore(broken, () => T0);
    await expect(s.userForPhone('+12155550001')).rejects.toThrow(/userForPhone: boom/);
    expect(fake).toBeDefined();
  });

  it('a code collision is retried with a new code', async () => {
    const fake = new FakeSupabase();
    const s = new SupabaseTextStore(fake as any, () => T0);
    const store = require('../services/textbot/store');
    const spy = jest.spyOn(store, 'newCode').mockReturnValueOnce('AAAAAA').mockReturnValueOnce('AAAAAA').mockReturnValueOnce('BBBBBB');
    expect((await s.createCode('link', 't', 'u')).code).toBe('AAAAAA');
    expect((await s.createCode('link', 't', 'u')).code).toBe('BBBBBB');
    spy.mockRestore();
  });
});
