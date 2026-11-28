/**
 * "Blue texts first" — nudge rules + engine (services/textbot/nudges.ts).
 * Fake clock, in-memory store, simulator provider. No AI, no network, no DB.
 * The trip mirrors a real saved trip's shape (Philadelphia → Venice → Rome → home).
 */
import { MemoryTextStore } from '../services/textbot/store';
import { SimulatorProvider } from '../services/textbot/providers/simulator';
import { candidateNudges, legsForNudges, NudgeEngine, type BookingLookup } from '../services/textbot/nudges';
import { localParts, timeZoneForCity, zonedToUtc } from '../services/textbot/timeZones';
import type { TripLoader } from '../services/textbot/types';

const TRIP_ID = 'trip-venice-rome';
const OWNER = 'u-owner';
const FRIEND = 'u-friend';
const P_OWNER = '+14155550001';
const P_FRIEND = '+14155550002';
const P_STRANGER = '+14155550009';

function trip() {
  return {
    id: TRIP_ID,
    title: 'Venice → Rome',
    returnToHome: true,
    origin: {
      city: 'Philadelphia',
      outboundLeg: { operator: 'American Airlines', departDate: '2027-05-15', departTime: '10:50', originAirport: 'PHL' },
      returnLeg: { operator: 'British Airways', departDate: '2027-05-27', departTime: '20:07', originAirport: 'FCO' },
    },
    cities: [
      { name: 'Venice', country: 'Italy', dates: { arrival: '2027-05-16', departure: '2027-05-22' },
        transportOut: { mode: 'train', operator: 'Trenitalia', departTime: '18:26' } },
      { name: 'Rome', country: 'Italy', dates: { arrival: '2027-05-22', departure: '2027-05-27' } },
    ],
  };
}

const utc = (iso: string) => Date.parse(iso);

function setup(opts: { booked?: string[]; tripOverride?: any } = {}) {
  const store = new MemoryTextStore();
  const provider = new SimulatorProvider();
  const members = new Map<string, 'owner' | 'editor' | 'viewer'>([[OWNER, 'owner'], [FRIEND, 'editor']]);
  const trips: TripLoader = {
    async load(id) { return id === TRIP_ID ? { trip: opts.tripOverride ?? trip(), title: 'Venice → Rome' } : null; },
    async members(id) { return id === TRIP_ID ? members : new Map(); },
  };
  const booked = new Set(opts.booked ?? []);
  const bookings: BookingLookup = { async isBooked(_t, leg) { return booked.has(leg.id); } };
  const engine = new NudgeEngine({ store, trips, provider, bookings });
  return { store, provider, members, engine, booked };
}

/** A linked group thread with both phones verified + consented. */
async function linkedGroup(env: ReturnType<typeof setup>, threadId = 'grp', phones = [P_OWNER, P_FRIEND]) {
  await env.store.linkThread({ provider: 'simulator', providerThreadId: threadId, tripId: TRIP_ID, linkedByUserId: OWNER });
  await env.store.linkPhone(OWNER, P_OWNER);
  await env.store.linkPhone(FRIEND, P_FRIEND);
  for (const p of phones) await env.store.setProactiveConsent(p, true);
  await env.store.setParticipants(`simulator:${threadId}`, phones);
}

describe('time zones', () => {
  it('places home and trip cities, DST-correct', () => {
    expect(timeZoneForCity('Philadelphia')).toBe('America/New_York');
    expect(timeZoneForCity('Venice', 'Italy')).toBe('Europe/Rome');
    expect(zonedToUtc('2027-05-15', '10:50', 'America/New_York')).toBe(utc('2027-05-15T14:50:00Z')); // EDT
    expect(zonedToUtc('2027-05-27', '20:07', 'Europe/Rome')).toBe(utc('2027-05-27T18:07:00Z')); // CEST
    expect(zonedToUtc('2027-01-15', '10:00', 'Europe/Rome')).toBe(utc('2027-01-15T09:00:00Z')); // CET
    expect(localParts(utc('2027-05-15T12:50:00Z'), 'America/New_York')).toEqual({ date: '2027-05-15', hour: 8, minute: 50 });
  });

  it('an unknown city has no zone (time-based nudges are skipped, not guessed)', () => {
    expect(timeZoneForCity('Atlantis')).toBeNull();
  });
});

describe('legsForNudges', () => {
  it('home → Venice, Venice → Rome, Rome → home with the right departure city', () => {
    const legs = legsForNudges(trip());
    expect(legs.map((l) => [l.id, l.departCity, l.mode, l.departDate, l.departTime])).toEqual([
      ['home→Venice', 'Philadelphia', 'flight', '2027-05-15', '10:50'],
      ['Venice→Rome', 'Venice', 'train', '2027-05-22', '18:26'],
      ['Rome→home', 'Rome', 'flight', '2027-05-27', '20:07'],
    ]);
  });
});

describe('candidateNudges (rules)', () => {
  const none: BookingLookup = { isBooked: async () => false };
  const all: BookingLookup = { isBooked: async () => true };

  it('unbooked: fires within 14 days of departure, not 15', async () => {
    const at14 = await candidateNudges(TRIP_ID, trip(), utc('2027-05-08T14:00:00Z'), none);
    expect(at14.map((n) => n.key)).toContain('unbooked:Venice→Rome:2027-05-22');
    const at15 = await candidateNudges(TRIP_ID, trip(), utc('2027-05-07T12:00:00Z'), none);
    expect(at15.map((n) => n.key)).not.toContain('unbooked:Venice→Rome:2027-05-22');
  });

  it('unbooked text names the leg, date, time and the trip link', async () => {
    const n = (await candidateNudges(TRIP_ID, trip(), utc('2027-05-20T10:00:00Z'), none)).find((x) => x.key.startsWith('unbooked:Venice→Rome'))!;
    expect(n.text).toBe(
      "Heads up: your Venice → Rome train on May 22 (18:26) isn't booked yet. Book it here: http://localhost:3000/results?tripId=trip-venice-rome",
    );
  });

  it('no unbooked nudge once the leg has departed, or when it is booked', async () => {
    const after = await candidateNudges(TRIP_ID, trip(), utc('2027-05-22T17:00:00Z'), none); // 19:00 Venice
    expect(after.map((n) => n.key)).not.toContain('unbooked:Venice→Rome:2027-05-22');
    const booked = await candidateNudges(TRIP_ID, trip(), utc('2027-05-20T10:00:00Z'), all);
    expect(booked.filter((n) => n.kind === 'unbooked_leg')).toEqual([]);
  });

  it('leave-now for a booked flight: at 08:50 Philadelphia time, 2 h before 10:50', async () => {
    const at = await candidateNudges(TRIP_ID, trip(), utc('2027-05-15T12:50:00Z'), all);
    const n = at.find((x) => x.kind === 'leave_now')!;
    expect(n.key).toBe('leave:home→Venice:2027-05-15');
    expect(n.text).toBe('Time to head to PHL airport: your American Airlines flight to Venice leaves at 10:50. Leave by 08:50 to be safe.');
    expect(at[0].kind).toBe('leave_now'); // most urgent first
  });

  it('leave-now window: not at 07:00, not after 09:05; train buffer is 30 min in Venice time', async () => {
    expect((await candidateNudges(TRIP_ID, trip(), utc('2027-05-15T11:00:00Z'), all)).some((n) => n.kind === 'leave_now')).toBe(false);
    expect((await candidateNudges(TRIP_ID, trip(), utc('2027-05-15T13:06:00Z'), all)).some((n) => n.kind === 'leave_now')).toBe(false);
    const train = await candidateNudges(TRIP_ID, trip(), utc('2027-05-22T15:56:00Z'), all); // 17:56 Venice
    expect(train.find((n) => n.kind === 'leave_now')?.text).toMatch(/head to the station: your Trenitalia train to Rome leaves at 18:26\. Leave by 17:56/);
  });

  it('no leave-now for a leg not known to be booked (default)', async () => {
    expect((await candidateNudges(TRIP_ID, trip(), utc('2027-05-15T12:50:00Z'), none)).some((n) => n.kind === 'leave_now')).toBe(false);
  });
});

describe('NudgeEngine (gates)', () => {
  // 2027-05-20 10:00 Venice: before departure? No — they're in Venice (16–22 May). Travelling.
  const VENICE_MORNING = utc('2027-05-20T08:00:00Z');

  it('sends the unbooked-train nudge once; a re-run sends nothing', async () => {
    const env = setup();
    await linkedGroup(env);
    const r1 = await env.engine.runOnce(VENICE_MORNING);
    expect(r1).toEqual([{ tripId: TRIP_ID, threadKey: 'simulator:grp', key: 'unbooked:Venice→Rome:2027-05-22', status: 'sent' }]);
    expect(env.provider.sent).toHaveLength(1);
    expect(env.provider.sent[0].threadId).toBe('grp');
    const r2 = await env.engine.runOnce(VENICE_MORNING + 60_000);
    expect(r2[0]).toMatchObject({ status: 'skipped', reason: 'too soon after the last nudge' });
    expect(env.provider.sent).toHaveLength(1);
    // 3 h later the next one (unbooked flight home) may go; the train nudge never repeats.
    await env.engine.runOnce(VENICE_MORNING + 3 * 3_600_000);
    expect(env.provider.sent.map((m) => m.text.slice(0, 40))).toEqual([
      'Heads up: your Venice → Rome train on Ma',
      'Heads up: your Rome → Philadelphia fligh',
    ]);
    await env.engine.runOnce(VENICE_MORNING + 7 * 3_600_000);
    expect(env.provider.sent).toHaveLength(2); // nothing left to say
  });

  it('leave-now ignores the 3-hour gap (it is time-critical)', async () => {
    const env = setup({ booked: ['home→Venice'] });
    await linkedGroup(env);
    // 15 May 08:00 Philadelphia: an unbooked-leg nudge goes out…
    expect((await env.engine.runOnce(utc('2027-05-15T12:00:00Z')))[0]).toMatchObject({ status: 'sent', key: expect.stringMatching(/^unbooked:/) });
    // …and 50 minutes later the leave-now still goes, despite the gap.
    expect((await env.engine.runOnce(utc('2027-05-15T12:50:00Z')))[0]).toMatchObject({ status: 'sent', key: 'leave:home→Venice:2027-05-15' });
    // A third, non-urgent one would wait.
    expect((await env.engine.runOnce(utc('2027-05-15T13:00:00Z')))[0].reason).toBe('too soon after the last nudge');
  });

  it('quiet hours in the city the travellers are in (22:30 Venice → nothing)', async () => {
    const env = setup();
    await linkedGroup(env);
    expect((await env.engine.runOnce(utc('2027-05-20T20:30:00Z')))[0].reason).toBe('quiet hours');
    expect(env.provider.sent).toHaveLength(0);
  });

  it('before the trip, quiet hours use the HOME clock (07:00 Philadelphia = 11:00Z → nothing)', async () => {
    const env = setup();
    await linkedGroup(env);
    expect((await env.engine.runOnce(utc('2027-05-10T11:00:00Z')))[0].reason).toBe('quiet hours');
    expect((await env.engine.runOnce(utc('2027-05-10T14:00:00Z')))[0].status).toBe('sent'); // 10:00 Philadelphia
  });

  it('budget before the trip: 1 a day, the next one waits for tomorrow', async () => {
    const env = setup();
    await linkedGroup(env);
    // 13–14 May: both the outbound flight and the train are unbooked and within 14 days.
    expect((await env.engine.runOnce(utc('2027-05-13T14:00:00Z')))[0].status).toBe('sent');
    expect((await env.engine.runOnce(utc('2027-05-13T16:00:00Z')))[0].reason).toBe('daily budget used');
    expect((await env.engine.runOnce(utc('2027-05-14T14:00:00Z')))[0].status).toBe('sent');
    expect(new Set(env.provider.sent.map((m) => m.text)).size).toBe(2);
  });

  it('muted thread gets nothing; unmuted it does', async () => {
    const env = setup();
    await linkedGroup(env);
    await env.store.setMutedUntil('simulator:grp', VENICE_MORNING + 3_600_000);
    expect((await env.engine.runOnce(VENICE_MORNING))[0].reason).toBe('no thread may receive it');
    expect((await env.engine.runOnce(VENICE_MORNING + 3_600_001))[0].status).toBe('sent');
  });

  it('an unverified person in the group blocks every nudge (privacy)', async () => {
    const env = setup();
    await linkedGroup(env, 'grp', [P_OWNER, P_FRIEND, P_STRANGER]);
    expect((await env.engine.runOnce(VENICE_MORNING))[0].reason).toBe('no thread may receive it');
    expect(env.provider.sent).toHaveLength(0);
  });

  it('a member removed from the trip mid-trip blocks nudges to that group', async () => {
    const env = setup();
    await linkedGroup(env);
    env.members.delete(FRIEND);
    expect((await env.engine.runOnce(VENICE_MORNING))[0].reason).toBe('no thread may receive it');
  });

  it('no consent, or an opted-out member → nothing', async () => {
    const env = setup();
    await linkedGroup(env);
    await env.store.setProactiveConsent(P_FRIEND, false);
    expect((await env.engine.runOnce(VENICE_MORNING))[0].reason).toBe('no thread may receive it');
    await env.store.setProactiveConsent(P_FRIEND, true);
    await env.store.setOptedOut(P_FRIEND, true);
    expect((await env.engine.runOnce(VENICE_MORNING))[0].reason).toBe('no thread may receive it');
    expect(env.provider.sent).toHaveLength(0);
  });

  it('one channel: with a group and a 1:1 linked, only the group gets it, once', async () => {
    const env = setup();
    await linkedGroup(env, 'dm-owner', [P_OWNER]);
    await linkedGroup(env, 'grp', [P_OWNER, P_FRIEND]);
    await env.engine.runOnce(VENICE_MORNING);
    await env.engine.runOnce(VENICE_MORNING + 60_000);
    expect(env.provider.sent.map((m) => m.threadId)).toEqual(['grp']);
  });

  it('after the trip ends: nothing', async () => {
    const env = setup();
    await linkedGroup(env);
    expect((await env.engine.runOnce(utc('2027-05-30T14:00:00Z')))[0].reason).toBe('trip over');
  });

  it('a failed send is marked failed and never retried (claim-first: no double send)', async () => {
    const env = setup();
    await linkedGroup(env);
    const send = jest.spyOn(env.provider, 'send').mockRejectedValueOnce(new Error('provider down'));
    expect((await env.engine.runOnce(VENICE_MORNING))[0].status).toBe('failed');
    send.mockRestore();
    await env.engine.runOnce(VENICE_MORNING + 60_000);
    expect(env.provider.sent.filter((m) => m.text.includes('Venice → Rome train'))).toHaveLength(0);
  });

  it('two overlapping runs in one process: the second does nothing', async () => {
    const env = setup();
    await linkedGroup(env);
    const [a, b] = await Promise.all([env.engine.runOnce(VENICE_MORNING), env.engine.runOnce(VENICE_MORNING)]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    expect(env.provider.sent).toHaveLength(1);
  });

  it('leave-now beats unbooked on the morning of a booked flight, and goes out at 08:50 local', async () => {
    const env = setup({ booked: ['home→Venice'] });
    await linkedGroup(env);
    const r = await env.engine.runOnce(utc('2027-05-15T12:50:00Z'));
    expect(r[0].key).toBe('leave:home→Venice:2027-05-15');
    expect(env.provider.sent[0].text).toMatch(/^Time to head to PHL airport/);
  });

  it('a trip whose cities have no known time zone is skipped, not guessed', async () => {
    const t = trip();
    t.origin.city = 'Atlantis';
    const env = setup({ tripOverride: t });
    await linkedGroup(env);
    expect((await env.engine.runOnce(utc('2027-05-10T14:00:00Z')))[0].reason).toBe('unknown time zone');
  });
});
