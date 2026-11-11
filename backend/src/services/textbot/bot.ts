import { logger } from '../../utils/logger';
import { maskPhone, toE164 } from './phone';
import { MAX_INBOUND_CHARS, SlidingLimiter, TEXT_LIMITS } from './rateLimit';
import type { MemberRole, TextStore } from './store';
import type {
  ChatEngine,
  ChatResult,
  InboundText,
  OutboundText,
  ProposalApplier,
  TextProvider,
  TripLoader,
} from './types';

/**
 * The group-text trip assistant's brain. Provider-independent: a provider
 * adapter (or the simulator) hands it an InboundText and it returns the
 * replies it sent.
 *
 * Safety rules, in the order they are checked:
 *  1. Duplicate deliveries (same provider message id) are dropped.
 *  2. In a group, the bot only reacts when addressed by its wake word, or to
 *     a "link/verify CODE" command, or to YES/NO while an edit is pending.
 *     Ordinary chatter is ignored and never stored.
 *  3. A thread shows trip details only when EVERY participant's phone is
 *     verified to a trip member. One unknown number → no trip details.
 *  4. Edits are never applied from a single message: the bot states the
 *     change and waits for YES from someone allowed to confirm.
 *  5. Per-person and per-thread rate limits cap AI cost and text spam.
 */

export type BotConfig = {
  name: string; // "BlueMurr"
  wakeWords: string[]; // lowercase; matched as whole words
  /** Roles whose YES applies an edit. */
  confirmRoles: MemberRole[];
  /** Roles allowed to link/unlink a thread to a trip. */
  linkRoles: MemberRole[];
  pendingTtlMs: number;
  /** Website base for "open the trip" links. */
  siteUrl: string;
  /** Hard cap per reply; long answers are cut at a sentence. */
  maxReplyChars: number;
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  name: 'BlueMurr',
  wakeWords: ['bluemurr', 'murr'],
  // Website saves are owner-only (canvas.ts), so texted edits match.
  confirmRoles: ['owner'],
  linkRoles: ['owner', 'editor'],
  pendingTtlMs: 10 * 60_000,
  siteUrl: 'http://localhost:3000',
  maxReplyChars: 900,
};

export type BotDeps = {
  store: TextStore;
  chat: ChatEngine;
  trips: TripLoader;
  provider: TextProvider;
  applier: ProposalApplier | null;
  limiter?: SlidingLimiter;
  config?: Partial<BotConfig>;
  now?: () => number;
};

/** Result types that change the trip and so need a YES before applying. */
const EDIT_TYPES = new Set(['proposal', 'leg_refresh']);
/** Result types that only inform. */
const READ_TYPES = new Set(['answer', 'mode_comparison']);

const YES = /^(y|yes|yep|yeah|confirm|do it|apply|ok|okay)[.! ]*$/i;
const NO = /^(n|no|nope|cancel|stop|don'?t)[.! ]*$/i;
const CODE_CMD = /^\s*(link|verify)\s+([A-Za-z0-9]{6})\s*$/i;

export class TextBot {
  private cfg: BotConfig;
  private limiter: SlidingLimiter;
  private now: () => number;

  constructor(private deps: BotDeps) {
    this.cfg = { ...DEFAULT_BOT_CONFIG, ...(deps.config ?? {}) };
    this.limiter = deps.limiter ?? new SlidingLimiter();
    this.now = deps.now ?? (() => Date.now());
  }

  get config(): Readonly<BotConfig> {
    return this.cfg;
  }

  /** Returns the replies sent (also delivered through the provider). */
  async handle(msg: InboundText): Promise<string[]> {
    const out: string[] = [];
    const reply = async (text: string) => {
      const clipped = clip(text, this.cfg.maxReplyChars);
      out.push(clipped);
      const o: OutboundText = { provider: msg.provider, threadId: msg.threadId, text: clipped };
      try {
        await this.deps.provider.send(o);
      } catch (err: any) {
        logger.warn('textbot send failed', { provider: msg.provider, message: err?.message });
      }
    };

    try {
      await this.process(msg, reply);
    } catch (err: any) {
      logger.error('textbot handle failed', { provider: msg.provider, message: err?.message });
      await reply("Sorry, something went wrong on my side. Try again in a minute.");
    }
    return out;
  }

  private async process(msg: InboundText, reply: (t: string) => Promise<void>) {
    const { store } = this.deps;
    const now = this.now();

    // 1. Dedupe redeliveries (providers retry on 5xx / timeouts).
    if (!(await store.markSeen(msg.provider, msg.providerMessageId))) return;

    const from = toE164(msg.from);
    if (!from) return;
    const participants = uniq(
      [from, ...msg.participants.map((p) => toE164(p)).filter((p): p is string => !!p)],
    );
    const isGroup = participants.length > 1;
    const text = (msg.text ?? '').trim();
    if (!text) return;

    const threadKey = store.threadKey(msg.provider, msg.threadId);
    const thread = await store.getThread(msg.provider, msg.threadId);
    const pending = thread ? await store.getPending(threadKey, now) : null;

    // 2. Is this message for us?
    const codeCmd = text.match(CODE_CMD);
    const yesNo = pending && (YES.test(text) || NO.test(text));
    const addressed = !isGroup || this.mentionsBot(text);
    if (!codeCmd && !yesNo && !addressed) return;

    // 5a. Per-person limit, before any work. Over the limit: one notice, then silence.
    if (!this.limiter.take(`phone:${from}`, TEXT_LIMITS.perPhone, now)) {
      if (!this.limiter.take(`phone-notice:${from}`, { limit: 1, ms: TEXT_LIMITS.perPhone.ms }, now)) return;
      return reply(`${maskPhone(from)}, you're sending messages faster than I can keep up. Give me a minute.`);
    }

    if (codeCmd) return this.handleCode(msg, from, codeCmd[1].toLowerCase() as 'link' | 'verify', codeCmd[2], reply);

    const body = this.stripWake(text).slice(0, MAX_INBOUND_CHARS);
    const lower = body.toLowerCase();

    if (lower === 'help' || lower === '') return reply(this.helpText(!!thread));
    if (!thread) {
      return reply(
        `Hi, I'm ${this.cfg.name}. This chat isn't linked to a trip yet. ` +
          `Open your trip on ${this.cfg.siteUrl}, tap "Text your trip", and send the code here as "link CODE".`,
      );
    }

    const members = await this.deps.trips.members(thread.tripId);
    const sender = await store.userForPhone(from);
    const senderRole = sender ? members.get(sender.userId) ?? null : null;

    if (lower === 'unlink') {
      if (!senderRole || !this.cfg.linkRoles.includes(senderRole)) {
        return reply('Only the trip owner or an editor can unlink this chat.');
      }
      await store.unlinkThread(msg.provider, msg.threadId);
      return reply("Done. This chat is no longer linked to the trip, and I've forgotten our conversation.");
    }

    // 3. Privacy: every participant must be a verified trip member.
    const outsiders: string[] = [];
    for (const p of participants) {
      const link = await store.userForPhone(p);
      if (!link || !members.has(link.userId)) outsiders.push(p);
    }
    if (outsiders.length) {
      return reply(
        `I can't share trip details while ${outsiders.map(maskPhone).join(', ')} ` +
          `${outsiders.length === 1 ? "isn't" : "aren't"} verified for this trip. ` +
          `Each person: open the trip on ${this.cfg.siteUrl}, tap "Text your trip", and send "verify CODE" here.`,
      );
    }
    if (!sender || !senderRole) return; // unreachable after the check above; belt and braces

    // 4. YES / NO on a pending edit.
    if (yesNo && pending) {
      if (NO.test(text)) {
        await store.clearPending(threadKey);
        return reply('OK, I dropped that change.');
      }
      if (!this.cfg.confirmRoles.includes(senderRole)) {
        return reply(`Only ${this.roleList(this.cfg.confirmRoles)} can confirm changes to this trip.`);
      }
      if (!this.deps.applier) {
        await store.clearPending(threadKey);
        return reply(`I can't apply changes from texts yet. Open the trip to accept it: ${this.tripUrl(thread.tripId)}`);
      }
      const res = await this.deps.applier.apply(thread.tripId, pending.result, sender.userId);
      await store.clearPending(threadKey);
      if (!res.ok) return reply(`I couldn't apply it: ${res.reason}. Nothing was changed.`);
      return reply(`Done: ${pending.summary} It's saved to the trip: ${this.tripUrl(thread.tripId)}`);
    }

    // 5b. Thread limits for AI turns.
    if (
      !this.limiter.take(`thread:${threadKey}`, TEXT_LIMITS.perThread, now) ||
      !this.limiter.take(`thread-day:${threadKey}`, TEXT_LIMITS.perThreadDaily, now)
    ) {
      return reply("This chat has hit my message limit for now. Try again a bit later, or use the website.");
    }

    const loaded = await this.deps.trips.load(thread.tripId);
    if (!loaded) return reply("I can't find that trip any more. It may have been deleted. Text \"unlink\" to reset.");

    const history = await store.history(threadKey);
    const result = await this.deps.chat.run({ message: body, currentTrip: loaded.trip, history });
    const replyText = plain(result.reply || '');

    await store.appendHistory(threadKey, { role: 'user', content: body });

    if (EDIT_TYPES.has(result.type)) {
      await store.setPending({
        threadKey,
        tripId: thread.tripId,
        requestedByUserId: sender.userId,
        result,
        summary: firstSentence(replyText),
        expiresAt: now + this.cfg.pendingTtlMs,
      });
      const who = this.roleList(this.cfg.confirmRoles);
      const ask = `\n\nReply YES to apply (${who}) or NO to drop it. Expires in ${Math.round(this.cfg.pendingTtlMs / 60_000)} min.`;
      await store.appendHistory(threadKey, { role: 'assistant', content: replyText });
      return reply(stripAcceptHint(replyText) + ask);
    }

    if (!READ_TYPES.has(result.type)) {
      // A result type the text channel doesn't know how to act on (e.g. a
      // new card type). Don't pretend: send the words and point at the site.
      logger.info('textbot unknown chat result type', { type: result.type });
    }
    await store.appendHistory(threadKey, { role: 'assistant', content: replyText });
    return reply(replyText || "I'm not sure. Try asking another way, or open the trip on the website.");
  }

  private async handleCode(
    msg: InboundText,
    from: string,
    kind: 'link' | 'verify',
    code: string,
    reply: (t: string) => Promise<void>,
  ) {
    const { store, trips } = this.deps;
    const now = this.now();
    if (this.limiter.blocked(`badcode:${from}`, TEXT_LIMITS.badCodes, now)) {
      return reply('Too many wrong codes from this number. Try again in an hour.');
    }
    const row = await store.consumeCode(code, now);
    if (!row || row.kind !== kind) {
      this.limiter.take(`badcode:${from}`, TEXT_LIMITS.badCodes, now);
      return reply("That code didn't work. Codes are single-use and expire after 15 minutes; get a new one on the website.");
    }
    const members = await trips.members(row.tripId);
    const role = members.get(row.userId);
    if (!role) return reply("That code's account isn't on this trip any more.");

    // The code proves the account; texting it proves the phone. Bind them.
    await store.linkPhone(row.userId, from);

    if (kind === 'verify') {
      return reply(`Thanks, ${maskPhone(from)} is verified. Say "${this.cfg.name}" plus a question to ask about the trip.`);
    }
    if (!this.cfg.linkRoles.includes(role)) {
      return reply(`Your number is verified, but only ${this.roleList(this.cfg.linkRoles)} can link a chat to the trip.`);
    }
    const loaded = await trips.load(row.tripId);
    await store.linkThread({
      provider: msg.provider,
      providerThreadId: msg.threadId,
      tripId: row.tripId,
      linkedByUserId: row.userId,
    });
    return reply(
      `Linked to "${loaded?.title ?? 'your trip'}". Everyone else here needs to verify their number before I share details: ` +
        `open the trip, tap "Text your trip", and send "verify CODE". Say "${this.cfg.name} help" any time.`,
    );
  }

  private mentionsBot(text: string): boolean {
    const t = text.toLowerCase();
    return this.cfg.wakeWords.some((w) => new RegExp(`(^|[^a-z0-9])@?${escapeRe(w)}([^a-z0-9]|$)`).test(t));
  }

  private stripWake(text: string): string {
    let t = text;
    for (const w of this.cfg.wakeWords) {
      t = t.replace(new RegExp(`^\\s*(hey\\s+|hi\\s+)?@?${escapeRe(w)}\\b[\\s,:!-]*`, 'i'), '');
    }
    return t.trim();
  }

  private helpText(linked: boolean): string {
    const n = this.cfg.name;
    return linked
      ? `Ask me about the trip: "${n} what time is our flight home?", "${n} where are we staying in Paris?". ` +
          `Ask for changes: "${n} add a night in London". I'll show the change and wait for YES. "${n} unlink" disconnects this chat.`
      : `I'm ${n}, a trip assistant. Link this chat to a trip with "link CODE" (from "Text your trip" on the website).`;
  }

  private roleList(roles: MemberRole[]): string {
    const names = roles.map((r) => (r === 'owner' ? 'the trip owner' : r === 'editor' ? 'an editor' : 'any member'));
    return names.join(' or ');
  }

  private tripUrl(tripId: string): string {
    return `${this.cfg.siteUrl.replace(/\/$/, '')}/trips/${tripId}`;
  }
}

// ─── text helpers ──────────────────────────────────────────────────────

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Texts render no markdown: drop **bold**, `code`, headings, bullets → "-". */
export function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.slice(0, max - 1)) + '…';
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

/** The web chat ends proposals with "Accept to apply it." — wrong channel. */
function stripAcceptHint(s: string): string {
  return s.replace(/\s*Accept to apply it\.?\s*$/i, '').trim();
}

export type { ChatResult };
