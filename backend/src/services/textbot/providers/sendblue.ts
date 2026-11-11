import { timingSafeEqual } from 'crypto';
import { logger } from '../../../utils/logger';
import { toE164 } from '../phone';
import type { InboundText, OutboundText, TextProvider } from '../types';

/**
 * Sendblue (iMessage) adapter. Field names from docs.sendblue.com, read
 * 2026-11-11:
 *   - list:  GET  /api/v2/messages  → { status, data: Message[], pagination: { limit, offset, total } }
 *   - 1:1:   POST /api/send-message        { number, from_number, content }
 *   - group: POST /api/send-group-message  { from_number, group_id, content }  (beta)
 *   - auth:  headers sb-api-key-id / sb-api-secret-key
 *   - inbound Message: message_handle, content, from_number, number,
 *     is_outbound, group_id ("" when not a group), participants, sendblue_number,
 *     date_sent
 *
 * Thread ids: "grp:<group_id>" for groups, "dm:<+E164>" for 1:1 chats.
 *
 * Credentials: in this cloud container the secret key is injected by the
 * network proxy on the sb-api-secret-key header (never in code or env);
 * the placeholder below is replaced in flight. Locally, set both env vars.
 */

export type SendblueMessage = {
  message_handle?: string;
  content?: string | null;
  from_number?: string | null;
  number?: string | null;
  to_number?: string | null;
  is_outbound?: boolean;
  group_id?: string | null;
  participants?: string[] | null;
  sendblue_number?: string | null;
  date_sent?: string | null;
  message_type?: string | null;
};

export type SendblueConfig = {
  baseUrl: string;
  apiKeyId: string;
  apiSecret: string;
  /** The bot's own Sendblue number, E.164. */
  fromNumber: string;
  fetchImpl?: typeof fetch;
};

export function sendblueConfigFromEnv(): SendblueConfig | null {
  const fromNumber = toE164(process.env.SENDBLUE_FROM_NUMBER ?? '');
  const apiKeyId = process.env.SENDBLUE_API_KEY_ID ?? '';
  if (!fromNumber || !apiKeyId) return null;
  return {
    baseUrl: process.env.SENDBLUE_BASE_URL || 'https://api.sendblue.com',
    apiKeyId,
    // Placeholder when the proxy injects the real secret on this header.
    apiSecret: process.env.SENDBLUE_API_SECRET || 'proxy-injected',
    fromNumber,
  };
}

/** Sendblue message → InboundText, or null if it is not for the bot. */
export function parseSendblueMessage(m: SendblueMessage, botNumber: string): InboundText | null {
  if (!m || m.is_outbound) return null;
  const handle = m.message_handle;
  const text = typeof m.content === 'string' ? m.content : '';
  if (!handle || !text.trim()) return null; // media-only / reactions: ignore
  const from = toE164(m.from_number ?? m.number ?? '');
  if (!from || from === botNumber) return null;
  const groupId = (m.group_id ?? '').trim();
  const participants = groupId
    ? (m.participants ?? [])
        .map((p) => toE164(p))
        .filter((p): p is string => !!p && p !== botNumber && p !== from)
    : [];
  return {
    provider: 'sendblue',
    threadId: groupId ? `grp:${groupId}` : `dm:${from}`,
    from,
    participants,
    text,
    providerMessageId: handle,
    receivedAt: m.date_sent ?? new Date().toISOString(),
  };
}

export class SendblueProvider implements TextProvider {
  readonly name = 'sendblue' as const;
  private fetch: typeof fetch;

  constructor(private cfg: SendblueConfig) {
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  private headers() {
    return {
      'content-type': 'application/json',
      'sb-api-key-id': this.cfg.apiKeyId,
      'sb-api-secret-key': this.cfg.apiSecret,
    };
  }

  async send(msg: OutboundText): Promise<void> {
    let path: string;
    let body: Record<string, unknown>;
    if (msg.threadId.startsWith('grp:')) {
      path = '/api/send-group-message';
      body = { from_number: this.cfg.fromNumber, group_id: msg.threadId.slice(4), content: msg.text };
    } else if (msg.threadId.startsWith('dm:')) {
      path = '/api/send-message';
      body = { number: msg.threadId.slice(3), from_number: this.cfg.fromNumber, content: msg.text };
    } else {
      throw new Error(`sendblue: unknown thread id ${msg.threadId}`);
    }
    const res = await this.fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`sendblue send HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
  }

  /**
   * Inbound messages sent at/after `since` (ISO), oldest first. Pages through
   * the offset pagination. Overlap between polls is expected: the bot drops
   * repeats by message_handle.
   */
  async listInbound(since: string, maxPages = 5): Promise<SendblueMessage[]> {
    const out: SendblueMessage[] = [];
    for (let page = 0, offset = 0; page < maxPages; page++) {
      const q = new URLSearchParams({
        is_outbound: 'false',
        created_at_gte: since,
        order_direction: 'asc',
        limit: '100',
        offset: String(offset),
      });
      const res = await this.fetch(`${this.cfg.baseUrl}/api/v2/messages?${q}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`sendblue list HTTP ${res.status}`);
      const json: any = await res.json();
      const data: SendblueMessage[] = Array.isArray(json?.data) ? json.data : [];
      out.push(...data);
      const total = Number(json?.pagination?.total ?? 0);
      offset += data.length;
      if (!data.length || offset >= total) break;
    }
    return out;
  }
}

/**
 * Dev mode: no public webhook can reach this backend, so poll. Every tick
 * lists inbound messages since a cursor (started at boot: no backlog
 * replay) and hands each to the bot, oldest first. Never overlaps itself.
 */
export class SendbluePoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cursor: string;

  constructor(
    private provider: SendblueProvider,
    private botNumber: string,
    private handle: (m: InboundText) => Promise<unknown>,
    private intervalMs = 4000,
    startAt = new Date(),
  ) {
    this.cursor = startAt.toISOString();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info('textbot sendblue poller started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Public for tests. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let handled = 0;
    try {
      const msgs = await this.provider.listInbound(this.cursor);
      for (const m of msgs) {
        const inbound = parseSendblueMessage(m, this.botNumber);
        if (m.date_sent && m.date_sent > this.cursor) this.cursor = m.date_sent;
        if (!inbound) continue;
        await this.handle(inbound);
        handled++;
      }
    } catch (err: any) {
      logger.warn('textbot sendblue poll failed', { message: err?.message });
    } finally {
      this.running = false;
    }
    return handled;
  }
}

/**
 * Webhook secret check. Sendblue sends the configured secret as a plain
 * header (no HMAC); the docs don't name the header, so it is configurable.
 * Constant-time compare; an unset secret rejects everything.
 */
export function sendblueWebhookAuthorized(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  headerName = process.env.SENDBLUE_WEBHOOK_SECRET_HEADER || 'sb-signing-secret',
): boolean {
  if (!secret) return false;
  const raw = headers[headerName.toLowerCase()];
  const got = Array.isArray(raw) ? raw[0] : raw;
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
