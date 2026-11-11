/**
 * Twilio 1:1 SMS adapter (services/textbot/providers/twilio.ts) against a
 * mocked fetch. NOT a live test: no request leaves the process.
 */
import {
  parseTwilioMessage,
  TwilioPoller,
  TwilioProvider,
  twilioSignature,
  twilioWebhookAuthorized,
} from '../services/textbot/providers/twilio';

const BOT = '+15005550006';
const SID = 'AC' + 'a'.repeat(32);

function provider(impl: any) {
  return new TwilioProvider({ baseUrl: 'https://api.twilio.com', accountSid: SID, authToken: 't'.repeat(32), fromNumber: BOT, fetchImpl: impl });
}

const inbound = (sid: string, at: string, body = 'BlueMurr hi', from = '+14155550001') => ({
  sid, from, to: BOT, body, direction: 'inbound', date_created: at, date_sent: at,
});

describe('parseTwilioMessage', () => {
  it('maps an inbound SMS to a 1:1 thread', () => {
    expect(parseTwilioMessage(inbound('SM1', 'Wed, 11 Nov 2026 20:10:00 +0000'), BOT)).toEqual({
      provider: 'twilio', threadId: 'dm:+14155550001', from: '+14155550001', participants: [],
      text: 'BlueMurr hi', providerMessageId: 'SM1', receivedAt: '2026-11-11T20:10:00.000Z',
    });
  });

  it('ignores outbound, empty, and messages to another number on the account', () => {
    expect(parseTwilioMessage({ ...inbound('SM2', 'x'), direction: 'outbound-api' }, BOT)).toBeNull();
    expect(parseTwilioMessage(inbound('SM3', 'x', '  '), BOT)).toBeNull();
    expect(parseTwilioMessage({ ...inbound('SM4', 'x'), to: '+15005550009' }, BOT)).toBeNull();
  });
});

describe('TwilioProvider.send', () => {
  it('posts To/From/Body form-encoded with basic auth', async () => {
    const calls: any[] = [];
    const impl = (async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => ({}) }; }) as any;
    await provider(impl).send({ provider: 'twilio', threadId: 'dm:+14155550001', text: 'Hi & bye' });
    expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({ To: '+14155550001', From: BOT, Body: 'Hi & bye' });
    expect(calls[0].init.headers.authorization).toBe('Basic ' + Buffer.from(`${SID}:${'t'.repeat(32)}`).toString('base64'));
  });

  it('names the trial "unverified number" error', async () => {
    const impl = (async () => ({ ok: false, status: 400, json: async () => ({ code: 21608, message: 'The number is unverified.' }) })) as any;
    await expect(provider(impl).send({ provider: 'twilio', threadId: 'dm:+14155550001', text: 'x' })).rejects.toThrow(
      /code 21608 \(trial accounts can only text verified numbers\)/,
    );
  });

  it('refuses group thread ids instead of texting the wrong place', async () => {
    await expect(provider(jest.fn()).send({ provider: 'twilio', threadId: 'grp:x', text: 'x' })).rejects.toThrow(/only 1:1/);
  });
});

describe('TwilioPoller', () => {
  const START = Date.parse('2026-11-11T20:00:00Z');

  function pollerWith(pages: any[][]) {
    const urls: string[] = [];
    let i = 0;
    const impl = (async (url: string) => {
      urls.push(url);
      const messages = pages[i] ?? [];
      const more = i < pages.length - 1;
      i++;
      return { ok: true, json: async () => ({ messages, next_page_uri: more ? `/2010-04-01/Accounts/${SID}/Messages.json?Page=${i}` : null }) };
    }) as any;
    const seen: string[] = [];
    const p = new TwilioPoller(provider(impl), BOT, async (m) => { seen.push(m.providerMessageId); }, 1000, new Date(START));
    return { p, seen, urls, reset: (np: any[][]) => { pages = np; i = 0; } };
  }

  it('handles only messages after start, oldest first, across pages; never twice', async () => {
    const env = pollerWith([
      [inbound('SM-new2', 'Wed, 11 Nov 2026 20:05:00 +0000'), inbound('SM-old', 'Wed, 11 Nov 2026 19:59:59 +0000')],
      [inbound('SM-new1', 'Wed, 11 Nov 2026 20:01:00 +0000')],
    ]);
    expect(await env.p.tick(START + 10 * 60_000)).toBe(2);
    expect(env.seen).toEqual(['SM-new1', 'SM-new2']);
    const q = new URL(env.urls[0]).searchParams;
    expect(q.get('To')).toBe(BOT);
    expect(q.get('DateSent>')).toBe('2026-11-10'); // the day before start: midnight-safe
    expect(env.urls[1]).toContain('Page=1');
    // Next tick lists the same messages again (day granularity): none re-handled.
    env.reset([[inbound('SM-new2', 'Wed, 11 Nov 2026 20:05:00 +0000'), inbound('SM-new3', 'Wed, 11 Nov 2026 20:06:00 +0000')]]);
    expect(await env.p.tick(START + 11 * 60_000)).toBe(1);
    expect(env.seen).toEqual(['SM-new1', 'SM-new2', 'SM-new3']);
  });

  it('a failed poll is logged, not thrown', async () => {
    const impl = (async () => ({ ok: false, status: 401 })) as any;
    const p = new TwilioPoller(provider(impl), BOT, async () => undefined);
    await expect(p.tick()).resolves.toBe(0);
  });
});

describe('X-Twilio-Signature', () => {
  const url = 'https://example.test/api/textbot/twilio/webhook';
  const params = { From: '+14155550001', To: BOT, Body: 'hi', MessageSid: 'SM1' };

  it('accepts the correct signature only', () => {
    const sig = twilioSignature('secret-token-1234567890', url, params);
    expect(twilioWebhookAuthorized(sig, 'secret-token-1234567890', url, params)).toBe(true);
    expect(twilioWebhookAuthorized(sig, 'other-token', url, params)).toBe(false);
    expect(twilioWebhookAuthorized(sig, 'secret-token-1234567890', url, { ...params, Body: 'HI' })).toBe(false);
    expect(twilioWebhookAuthorized(sig, 'secret-token-1234567890', url + '?x=1', params)).toBe(false);
    expect(twilioWebhookAuthorized(undefined, 'secret-token-1234567890', url, params)).toBe(false);
  });

  it('never accepts when the token is the proxy placeholder', () => {
    const dummy = '0'.repeat(32);
    expect(twilioWebhookAuthorized(twilioSignature(dummy, url, params), dummy, url, params)).toBe(false);
  });

  it('matches the official twilio SDK (getExpectedTwilioSignature, twilio@5) on a fixed vector', () => {
    // Value produced by the SDK on 2026-11-11 for exactly these inputs.
    expect(
      twilioSignature('secret-token-1234567890', 'https://example.test/api/textbot/twilio/webhook', {
        From: '+14155550001', To: '+15005550006', Body: 'hi & bye', MessageSid: 'SM1',
      }),
    ).toBe('NVqGT5o2hy8HOGqOuu07u234DLw=');
  });

  it('is order-independent in params (sorted by name)', () => {
    const a = twilioSignature('t', url, { B: '2', A: '1' });
    const b = twilioSignature('t', url, { A: '1', B: '2' });
    expect(a).toBe(b);
  });
});
