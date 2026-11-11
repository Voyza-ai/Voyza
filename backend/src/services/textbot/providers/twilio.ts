import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../../../utils/logger';
import { toE164 } from '../phone';
import type { InboundText, OutboundText, TextProvider } from '../types';

/**
 * Twilio Programmable Messaging adapter — 1:1 SMS.
 *
 *   send:  POST /2010-04-01/Accounts/{Sid}/Messages.json   (form: To, From, Body)
 *   list:  GET  /2010-04-01/Accounts/{Sid}/Messages.json?To=&DateSent>=YYYY-MM-DD&PageSize=
 *          → { messages: [{ sid, from, to, body, direction, date_created, date_sent }], next_page_uri }
 *   auth:  HTTP basic, Account SID : Auth Token
 *
 * In this cloud container the network proxy injects the real basic-auth
 * credentials for api.twilio.com; the values from env may be well-formed
 * dummies. Group MMS (Conversations) is a separate adapter, if the trial
 * account supports it at all.
 *
 * Thread ids: "dm:<+E164>".
 */

export type TwilioMessage = {
  sid?: string;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  direction?: string | null; // 'inbound' | 'outbound-api' | 'outbound-reply' | ...
  date_created?: string | null; // RFC 2822
  date_sent?: string | null;
};

export type TwilioConfig = {
  baseUrl: string;
  accountSid: string;
  authToken: string;
  /** The bot's Twilio number, E.164. */
  fromNumber: string;
  fetchImpl?: typeof fetch;
};

/** Well-formed placeholders: the proxy swaps in the real basic auth. */
const DUMMY_SID = 'AC00000000000000000000000000000000';
const DUMMY_TOKEN = '00000000000000000000000000000000';

export function twilioConfigFromEnv(): TwilioConfig | null {
  const fromNumber = toE164(process.env.TWILIO_FROM_NUMBER ?? '');
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  if (!fromNumber || !/^AC[0-9a-f]{32}$/i.test(accountSid)) return null;
  return {
    baseUrl: process.env.TWILIO_BASE_URL || 'https://api.twilio.com',
    accountSid,
    authToken: process.env.TWILIO_AUTH_TOKEN || DUMMY_TOKEN,
    fromNumber,
  };
}

export function parseTwilioMessage(m: TwilioMessage, botNumber: string): InboundText | null {
  if (!m?.sid || m.direction !== 'inbound') return null;
  const text = typeof m.body === 'string' ? m.body : '';
  if (!text.trim()) return null;
  const from = toE164(m.from ?? '');
  if (!from || from === botNumber) return null;
  if (toE164(m.to ?? '') !== botNumber) return null; // another number on the account
  return {
    provider: 'twilio',
    threadId: `dm:${from}`,
    from,
    participants: [],
    text,
    providerMessageId: m.sid,
    receivedAt: toIso(m.date_sent ?? m.date_created) ?? new Date().toISOString(),
  };
}

function toIso(rfc2822: string | null | undefined): string | null {
  if (!rfc2822) return null;
  const t = Date.parse(rfc2822);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Twilio error codes worth naming in logs and to the owner. */
export const TWILIO_ERRORS: Record<number, string> = {
  21608: 'trial accounts can only text verified numbers',
  21211: 'invalid "To" phone number',
  21610: 'recipient has replied STOP (unsubscribed)',
  30034: 'US number not registered for A2P 10DLC',
};

export class TwilioProvider implements TextProvider {
  readonly name = 'twilio' as const;
  private fetch: typeof fetch;

  constructor(private cfg: TwilioConfig) {
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  private auth() {
    return 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
  }

  private url(path: string) {
    return `${this.cfg.baseUrl}/2010-04-01/Accounts/${this.cfg.accountSid}${path}`;
  }

  async send(msg: OutboundText): Promise<void> {
    if (!msg.threadId.startsWith('dm:')) throw new Error(`twilio: only 1:1 threads are supported (${msg.threadId})`);
    const body = new URLSearchParams({ To: msg.threadId.slice(3), From: this.cfg.fromNumber, Body: msg.text });
    const res = await this.fetch(this.url('/Messages.json'), {
      method: 'POST',
      headers: { authorization: this.auth(), 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      let code: number | undefined;
      let detail = '';
      try {
        const j: any = await res.json();
        code = Number(j?.code);
        detail = String(j?.message ?? '');
      } catch {
        /* non-JSON error body */
      }
      const known = code && TWILIO_ERRORS[code] ? ` (${TWILIO_ERRORS[code]})` : '';
      throw new Error(`twilio send HTTP ${res.status} code ${code ?? '?'}${known}: ${detail.slice(0, 200)}`);
    }
  }

  /** Inbound messages to the bot's number sent on/after `sinceDay` (YYYY-MM-DD, UTC). */
  async listInbound(sinceDay: string, maxPages = 5): Promise<TwilioMessage[]> {
    const out: TwilioMessage[] = [];
    const q = new URLSearchParams({ To: this.cfg.fromNumber, 'DateSent>': sinceDay, PageSize: '100' });
    let next: string | null = this.url(`/Messages.json?${q}`);
    for (let page = 0; next && page < maxPages; page++) {
      const res: any = await this.fetch(next, { headers: { authorization: this.auth() } });
      if (!res.ok) throw new Error(`twilio list HTTP ${res.status}`);
      const json: any = await res.json();
      out.push(...(Array.isArray(json?.messages) ? json.messages : []));
      next = json?.next_page_uri ? `${this.cfg.baseUrl}${json.next_page_uri}` : null;
    }
    return out;
  }
}

/**
 * Dev mode poller. Twilio's DateSent filter is whole days, so each poll
 * lists today's (and, near midnight, yesterday's) inbound messages and skips
 * any created before the poller started or already handed over. List order
 * is newest first, so messages are sorted oldest-first before handling.
 */
export class TwilioPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private handled = new Set<string>();
  private readonly startedAt: number;

  constructor(
    private provider: TwilioProvider,
    private botNumber: string,
    private handle: (m: InboundText) => Promise<unknown>,
    private intervalMs = 4000,
    startAt = new Date(),
  ) {
    this.startedAt = startAt.getTime();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info('textbot twilio poller started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      // From the day before, so a message at 23:59:59 UTC isn't missed at midnight.
      const sinceDay = new Date(Math.min(now, this.startedAt) - 86_400_000).toISOString().slice(0, 10);
      const msgs = await this.provider.listInbound(sinceDay);
      const fresh = msgs
        .map((m) => ({ m, t: Date.parse(m.date_created ?? m.date_sent ?? '') }))
        .filter(({ m, t }) => m.sid && !this.handled.has(m.sid) && Number.isFinite(t) && t >= this.startedAt)
        .sort((a, b) => a.t - b.t);
      for (const { m } of fresh) {
        this.handled.add(m.sid!);
        const inbound = parseTwilioMessage(m, this.botNumber);
        if (!inbound) continue;
        await this.handle(inbound);
        count++;
      }
    } catch (err: any) {
      logger.warn('textbot twilio poll failed', { message: err?.message });
    } finally {
      this.running = false;
    }
    return count;
  }
}

/**
 * X-Twilio-Signature for a form-encoded webhook: base64(HMAC-SHA1(authToken,
 * fullUrl + each POST param name+value, names sorted)). Constant-time compare.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function twilioWebhookAuthorized(
  signature: string | undefined,
  authToken: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!authToken || !signature || authToken === DUMMY_TOKEN) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const TWILIO_DUMMIES = { sid: DUMMY_SID, token: DUMMY_TOKEN };
