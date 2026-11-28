/**
 * Twilio Conversations group MMS (services/textbot/providers/twilioGroups.ts)
 * against a mocked fetch. NOT a live test.
 */
import { TwilioGroupPoller, TwilioGroups } from '../services/textbot/providers/twilioGroups';

const BOT = '+12155550100';
const SID = 'AC' + 'a'.repeat(32);
const CONV = 'CH' + 'b'.repeat(32);
const ME = '+12155550001';
const FRIEND = '+12155550002';

type Call = { method: string; url: string; form: Record<string, string> };

function fake(routes: (c: Call) => any) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: any = {}) => {
    const c = { method: init.method ?? 'GET', url, form: Object.fromEntries(new URLSearchParams(init.body ?? '')) };
    calls.push(c);
    const body = routes(c);
    if (body && body.__status) return { ok: false, status: body.__status, json: async () => body };
    return { ok: true, status: 200, json: async () => body };
  }) as any;
  return { impl, calls };
}

const groups = (impl: any) =>
  new TwilioGroups({ baseUrl: 'https://api.twilio.com', accountSid: SID, authToken: 't'.repeat(32), fromNumber: BOT, fetchImpl: impl });

describe('TwilioGroups.createGroup', () => {
  it('creates the conversation, adds Blue as the projected address, then each person', async () => {
    const f = fake((c) => (c.url.endsWith('/v1/Conversations') ? { sid: CONV } : { sid: 'MBx' }));
    expect(await groups(f.impl).createGroup([ME, FRIEND, BOT], 'Venice → Rome')).toBe(`conv:${CONV}`);
    expect(f.calls.map((c) => [c.method, c.url.replace('https://conversations.twilio.com', ''), c.form])).toEqual([
      ['POST', '/v1/Conversations', { FriendlyName: 'Venice → Rome' }],
      ['POST', `/v1/Conversations/${CONV}/Participants`, { 'MessagingBinding.ProjectedAddress': BOT }],
      ['POST', `/v1/Conversations/${CONV}/Participants`, { 'MessagingBinding.Address': ME }],
      ['POST', `/v1/Conversations/${CONV}/Participants`, { 'MessagingBinding.Address': FRIEND }],
    ]);
  });

  it('refuses non-+1 numbers, fewer than 2 people, and more than 10 participants', async () => {
    const f = fake(() => ({ sid: CONV }));
    await expect(groups(f.impl).createGroup([ME, '+447700900123'])).rejects.toThrow(/US\/Canada/);
    await expect(groups(f.impl).createGroup([ME])).rejects.toThrow(/at least 2/);
    const ten = Array.from({ length: 10 }, (_, i) => `+1215555${String(1000 + i)}`);
    await expect(groups(f.impl).createGroup(ten)).rejects.toThrow(/10 participants/);
    expect(f.calls).toHaveLength(0); // nothing created on a refusal
  });
});

describe('TwilioGroups.send', () => {
  it('posts to the conversation with Blue as author', async () => {
    const f = fake(() => ({ sid: 'IMx' }));
    await groups(f.impl).send({ provider: 'twilio', threadId: `conv:${CONV}`, text: 'hello group' });
    expect(f.calls[0].url).toBe(`https://conversations.twilio.com/v1/Conversations/${CONV}/Messages`);
    expect(f.calls[0].form).toEqual({ Author: BOT, Body: 'hello group' });
  });

  it('refuses a 1:1 thread id and surfaces Twilio errors', async () => {
    const f = fake(() => ({ __status: 400, code: 50407, message: 'bad' }));
    await expect(groups(f.impl).send({ provider: 'twilio', threadId: 'dm:+1', text: 'x' })).rejects.toThrow(/not a group thread/);
    await expect(groups(f.impl).send({ provider: 'twilio', threadId: `conv:${CONV}`, text: 'x' })).rejects.toThrow(/HTTP 400 code 50407/);
  });
});

describe('TwilioGroupPoller', () => {
  const START = Date.parse('2026-11-28T20:00:00Z');
  const participants = {
    participants: [
      { sid: 'MB-bot', messaging_binding: { type: 'sms', projected_address: BOT } },
      { sid: 'MB-me', messaging_binding: { type: 'sms', address: ME } },
      { sid: 'MB-friend', messaging_binding: { type: 'sms', address: FRIEND } },
    ],
  };
  let messages: any[] = [];
  const f = fake((c) => {
    if (c.url.includes('/Participants')) return participants;
    if (c.url.includes('/Messages')) return { messages };
    return { conversations: [{ sid: CONV }] };
  });

  it('hands new group messages to the bot oldest-first, with the sender and other members; never twice; skips Blue and old ones', async () => {
    messages = [
      { sid: 'IM3', participant_sid: null, author: BOT, body: 'Blue reply', date_created: '2026-11-28T20:03:00Z' },
      { sid: 'IM2', participant_sid: 'MB-friend', author: FRIEND, body: 'BlueMurr hi', date_created: '2026-11-28T20:02:00Z' },
      { sid: 'IM1', participant_sid: 'MB-me', author: ME, body: 'hey', date_created: '2026-11-28T20:01:00Z' },
      { sid: 'IM0', participant_sid: 'MB-me', author: ME, body: 'old', date_created: '2026-11-28T19:59:00Z' },
    ];
    const seen: any[] = [];
    const p = new TwilioGroupPoller(groups(f.impl), BOT, async (m) => { seen.push(m); }, 1000, new Date(START));
    expect(await p.tick()).toBe(2);
    expect(seen.map((m) => [m.providerMessageId, m.from, m.participants, m.threadId])).toEqual([
      ['IM1', ME, [FRIEND], `conv:${CONV}`],
      ['IM2', FRIEND, [ME], `conv:${CONV}`],
    ]);
    expect(await p.tick()).toBe(0);
  });

  it('a failed poll is logged, not thrown', async () => {
    const bad = fake(() => ({ __status: 401, code: 20003, message: 'auth' }));
    const p = new TwilioGroupPoller(groups(bad.impl), BOT, async () => undefined);
    await expect(p.tick()).resolves.toBe(0);
  });
});
