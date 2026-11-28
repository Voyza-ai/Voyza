import { logger } from '../../../utils/logger';
import { toE164 } from '../phone';
import type { InboundText, OutboundText, TextProvider } from '../types';
import type { TwilioConfig } from './twilio';

/**
 * Twilio Conversations — group MMS (you + friend + Blue in one thread).
 * From the Conversations (classic) docs, read 2026-11-28:
 *   create: POST /v1/Conversations                          { FriendlyName }
 *   bot:    POST /v1/Conversations/{sid}/Participants        { MessagingBinding.ProjectedAddress: <our number> }
 *   person: POST /v1/Conversations/{sid}/Participants        { MessagingBinding.Address: <their number> }
 *   send:   POST /v1/Conversations/{sid}/Messages            { Author: <our number>, Body }  (standalone projected address)
 *   read:   GET  /v1/Conversations?State=active, GET …/{sid}/Messages?Order=desc, GET …/{sid}/Participants
 * US/Canada +1 long codes only; up to 10 participants (docs also say 20 — verify live).
 *
 * Blue STARTS the group itself (createGroup), so no console "autocreation"
 * setting is needed for the demo. Thread ids: "conv:<ConversationSid>".
 *
 * NOT TESTED LIVE: field shapes for participant bindings and SMS authors are
 * partly from doc summaries; the poller maps participant_sid → address rather
 * than trusting `author`.
 */

const MAX_PARTICIPANTS = 10;

type ConvParticipant = {
  sid: string;
  messaging_binding?: { type?: string; address?: string | null; proxy_address?: string | null; projected_address?: string | null } | null;
};
type ConvMessage = {
  sid: string;
  author?: string | null;
  body?: string | null;
  participant_sid?: string | null;
  date_created?: string | null;
  index?: number;
};

export class TwilioGroups implements TextProvider {
  readonly name = 'twilio' as const;
  private fetch: typeof fetch;
  private base: string;

  constructor(private cfg: TwilioConfig & { conversationsBaseUrl?: string }) {
    this.fetch = cfg.fetchImpl ?? fetch;
    this.base = cfg.conversationsBaseUrl ?? 'https://conversations.twilio.com';
  }

  private auth() {
    return 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
  }

  private async call(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<any> {
    const res = await this.fetch(path.startsWith('http') ? path : `${this.base}${path}`, {
      method,
      headers: {
        authorization: this.auth(),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j: any = await res.json();
        detail = `code ${j?.code ?? '?'}: ${String(j?.message ?? '').slice(0, 200)}`;
      } catch {
        /* non-JSON */
      }
      throw new Error(`twilio conversations ${method} ${path.split('?')[0]} HTTP ${res.status} ${detail}`.trim());
    }
    return res.json();
  }

  /** Blue starts a group text with these people. Returns the thread id. */
  async createGroup(phones: string[], name = 'BlueMurr trip'): Promise<string> {
    const people = [...new Set(phones.map((p) => toE164(p)).filter((p): p is string => !!p))].filter(
      (p) => p !== this.cfg.fromNumber,
    );
    if (people.length < 2) throw new Error('a group needs at least 2 other phone numbers');
    if (people.length + 1 > MAX_PARTICIPANTS) throw new Error(`a Twilio group text allows ${MAX_PARTICIPANTS} participants`);
    if (people.some((p) => !p.startsWith('+1'))) throw new Error('Twilio group texting works with US/Canada (+1) numbers only');
    const conv = await this.call('POST', '/v1/Conversations', { FriendlyName: name });
    const sid = String(conv?.sid ?? '');
    if (!/^CH[0-9a-f]{32}$/i.test(sid)) throw new Error('twilio conversations: no Conversation sid returned');
    await this.call('POST', `/v1/Conversations/${sid}/Participants`, { 'MessagingBinding.ProjectedAddress': this.cfg.fromNumber });
    for (const p of people) {
      await this.call('POST', `/v1/Conversations/${sid}/Participants`, { 'MessagingBinding.Address': p });
    }
    return `conv:${sid}`;
  }

  async send(msg: OutboundText): Promise<void> {
    if (!msg.threadId.startsWith('conv:')) throw new Error(`twilio groups: not a group thread (${msg.threadId})`);
    const sid = msg.threadId.slice(5);
    await this.call('POST', `/v1/Conversations/${sid}/Messages`, { Author: this.cfg.fromNumber, Body: msg.text.slice(0, 1600) });
  }

  async activeConversations(): Promise<string[]> {
    const j = await this.call('GET', '/v1/Conversations?State=active&PageSize=50');
    return (Array.isArray(j?.conversations) ? j.conversations : []).map((c: any) => String(c.sid)).filter(Boolean);
  }

  /** SMS participants' numbers, keyed by participant sid; the bot's own binding is skipped. */
  async participants(sid: string): Promise<Map<string, string>> {
    const j = await this.call('GET', `/v1/Conversations/${sid}/Participants?PageSize=50`);
    const out = new Map<string, string>();
    for (const p of (Array.isArray(j?.participants) ? j.participants : []) as ConvParticipant[]) {
      const addr = toE164(p.messaging_binding?.address ?? '');
      if (addr && addr !== this.cfg.fromNumber) out.set(p.sid, addr);
    }
    return out;
  }

  async recentMessages(sid: string, pageSize = 20): Promise<ConvMessage[]> {
    const j = await this.call('GET', `/v1/Conversations/${sid}/Messages?Order=desc&PageSize=${pageSize}`);
    return Array.isArray(j?.messages) ? j.messages : [];
  }
}

/**
 * Dev-mode poller for group conversations. Each tick: active conversations →
 * newest messages → oldest-first, skipping anything from before the poller
 * started, anything already handled, and anything the bot wrote.
 */
export class TwilioGroupPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private handled = new Set<string>();
  private readonly startedAt: number;

  constructor(
    private groups: TwilioGroups,
    private botNumber: string,
    private handle: (m: InboundText) => Promise<unknown>,
    private intervalMs = 5000,
    startAt = new Date(),
  ) {
    this.startedAt = startAt.getTime();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info('textbot twilio group poller started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      for (const sid of await this.groups.activeConversations()) {
        const msgs = (await this.groups.recentMessages(sid))
          .map((m) => ({ m, t: Date.parse(m.date_created ?? '') }))
          .filter(({ m, t }) => m.sid && !this.handled.has(m.sid) && Number.isFinite(t) && t >= this.startedAt)
          .sort((a, b) => a.t - b.t);
        if (!msgs.length) continue;
        const people = await this.groups.participants(sid);
        for (const { m } of msgs) {
          this.handled.add(m.sid);
          const from =
            (m.participant_sid && people.get(m.participant_sid)) || toE164(m.author ?? '') || null;
          const text = (m.body ?? '').trim();
          if (!from || from === this.botNumber || !text) continue;
          await this.handle({
            provider: 'twilio',
            threadId: `conv:${sid}`,
            from,
            participants: [...people.values()].filter((p) => p !== from),
            text,
            providerMessageId: m.sid,
            receivedAt: new Date(Date.parse(m.date_created ?? '') || Date.now()).toISOString(),
          });
          count++;
        }
      }
    } catch (err: any) {
      logger.warn('textbot twilio group poll failed', { message: err?.message });
    } finally {
      this.running = false;
    }
    return count;
  }
}
