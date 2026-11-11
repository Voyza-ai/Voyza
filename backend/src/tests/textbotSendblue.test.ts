/**
 * Sendblue adapter (services/textbot/providers/sendblue.ts) against a mocked
 * fetch. Request/response shapes follow docs.sendblue.com as read 2026-11-11.
 * NOT a live test: no request leaves the process.
 */
import {
  parseSendblueMessage,
  SendbluePoller,
  SendblueProvider,
  sendblueWebhookAuthorized,
} from '../services/textbot/providers/sendblue';

const BOT = '+14155550100';

function fakeFetch(pages: any[][] = []) {
  const calls: Array<{ url: string; init: any }> = [];
  let pageIdx = 0;
  const impl = (async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.includes('/api/v2/messages')) {
      const all = pages.flat();
      const offset = Number(new URL(url).searchParams.get('offset'));
      const data = pages[pageIdx++] ?? [];
      return { ok: true, status: 200, json: async () => ({ status: 'OK', data, pagination: { limit: 100, offset, total: all.length } }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'QUEUED' }), text: async () => '' };
  }) as any;
  return { impl, calls };
}

const provider = (impl: any) =>
  new SendblueProvider({ baseUrl: 'https://api.sendblue.com', apiKeyId: 'kid', apiSecret: 'sec', fromNumber: BOT, fetchImpl: impl });

describe('parseSendblueMessage', () => {
  it('maps a group message, dropping the bot and sender from participants', () => {
    const m = parseSendblueMessage(
      {
        message_handle: 'h1', content: 'BlueMurr hi', from_number: '+14155550001', is_outbound: false,
        group_id: 'g-123', participants: ['+14155550001', '+14155550002', BOT], date_sent: '2026-11-11T16:00:00Z',
      },
      BOT,
    );
    expect(m).toEqual({
      provider: 'sendblue', threadId: 'grp:g-123', from: '+14155550001', participants: ['+14155550002'],
      text: 'BlueMurr hi', providerMessageId: 'h1', receivedAt: '2026-11-11T16:00:00Z',
    });
  });

  it('maps a 1:1 message (group_id is "")', () => {
    const m = parseSendblueMessage({ message_handle: 'h2', content: 'hi', number: '4155550001', group_id: '', is_outbound: false }, BOT);
    expect(m?.threadId).toBe('dm:+14155550001');
    expect(m?.participants).toEqual([]);
  });

  it('ignores outbound, empty, handle-less and own-number messages', () => {
    expect(parseSendblueMessage({ message_handle: 'a', content: 'x', from_number: '+14155550001', is_outbound: true }, BOT)).toBeNull();
    expect(parseSendblueMessage({ message_handle: 'b', content: '  ', from_number: '+14155550001' }, BOT)).toBeNull();
    expect(parseSendblueMessage({ content: 'x', from_number: '+14155550001' }, BOT)).toBeNull();
    expect(parseSendblueMessage({ message_handle: 'c', content: 'x', from_number: BOT }, BOT)).toBeNull();
  });
});

describe('SendblueProvider.send', () => {
  it('group threads use send-group-message with group_id + from_number', async () => {
    const f = fakeFetch();
    await provider(f.impl).send({ provider: 'sendblue', threadId: 'grp:g-123', text: 'hello' });
    expect(f.calls[0].url).toBe('https://api.sendblue.com/api/send-group-message');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ from_number: BOT, group_id: 'g-123', content: 'hello' });
    expect(f.calls[0].init.headers['sb-api-key-id']).toBe('kid');
    expect(f.calls[0].init.headers['sb-api-secret-key']).toBe('sec');
  });

  it('1:1 threads use send-message with number', async () => {
    const f = fakeFetch();
    await provider(f.impl).send({ provider: 'sendblue', threadId: 'dm:+14155550001', text: 'hi' });
    expect(f.calls[0].url).toBe('https://api.sendblue.com/api/send-message');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ number: '+14155550001', from_number: BOT, content: 'hi' });
  });

  it('a non-2xx send throws with the status', async () => {
    const impl = (async () => ({ ok: false, status: 402, text: async () => 'plan does not include groups' })) as any;
    await expect(provider(impl).send({ provider: 'sendblue', threadId: 'grp:x', text: 'hi' })).rejects.toThrow(/402: plan does not include groups/);
  });
});

describe('SendbluePoller', () => {
  it('pages, hands messages to the bot oldest-first, advances the cursor', async () => {
    const msg = (h: string, t: string) => ({ message_handle: h, content: `BlueMurr ${h}`, from_number: '+14155550001', group_id: 'g', participants: [], is_outbound: false, date_sent: t });
    const page1 = Array.from({ length: 100 }, (_, i) => msg(`a${i}`, `2026-11-11T16:00:${String(i % 60).padStart(2, '0')}Z`));
    const page2 = [msg('b0', '2026-11-11T16:05:00Z')];
    const f = fakeFetch([page1, page2]);
    const seen: string[] = [];
    const p = new SendbluePoller(provider(f.impl), BOT, async (m) => { seen.push(m.providerMessageId); }, 1000, new Date('2026-11-11T15:59:00Z'));
    expect(await p.tick()).toBe(101);
    expect(seen[0]).toBe('a0');
    expect(seen[100]).toBe('b0');
    const q = new URL(f.calls[0].url).searchParams;
    expect(q.get('is_outbound')).toBe('false');
    expect(q.get('created_at_gte')).toBe('2026-11-11T15:59:00.000Z');
    expect(new URL(f.calls[1].url).searchParams.get('offset')).toBe('100');
    // Next tick starts from the newest message seen.
    await p.tick();
    expect(new URL(f.calls[2].url).searchParams.get('created_at_gte')).toBe('2026-11-11T16:05:00Z');
  });

  it('a failed poll is logged, not thrown', async () => {
    const impl = (async () => ({ ok: false, status: 401 })) as any;
    const p = new SendbluePoller(provider(impl), BOT, async () => undefined);
    await expect(p.tick()).resolves.toBe(0);
  });
});

describe('sendblueWebhookAuthorized', () => {
  it('accepts only the exact secret, and nothing when no secret is configured', () => {
    expect(sendblueWebhookAuthorized({ 'sb-signing-secret': 's3cret' }, 's3cret')).toBe(true);
    expect(sendblueWebhookAuthorized({ 'sb-signing-secret': 's3cre' }, 's3cret')).toBe(false);
    expect(sendblueWebhookAuthorized({}, 's3cret')).toBe(false);
    expect(sendblueWebhookAuthorized({ 'sb-signing-secret': '' }, undefined)).toBe(false);
  });
});
