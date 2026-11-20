/**
 * Where the traveller flies FROM, and whether they fly back: the two facts
 * the chat planner must ask about rather than guess. Enforced in code on
 * every /api/plan/converse turn (planConverse.ts), because the prompt alone
 * did not hold.
 *
 * Production, 2026-11-17: "we are flying out of paris to london to go back
 * to paris and then munich" was planned with Paris as HOME and as one-way —
 * the model read "flying out of Paris" as the origin and invented
 * returnToHome=false — and the chat never asked either question before
 * "That's everything I need". Paris was the first stop of the route; where
 * they were flying in from was never asked.
 *
 * The rules:
 *   - returnToHome is taken only from a message that says round-trip /
 *     one-way / back home. A route that returns to a trip city is not that.
 *   - origin is taken from a message that says the city is home ("I live in
 *     Paris", "we're based in Paris"), or that answers a question about where
 *     they fly from, or that corrects an origin they already gave. Otherwise
 *     the chat asks to confirm it, with the city as a one-tap answer.
 *   - The chat is not finished ('ready') while either one is unknown.
 */
import type { ConverseResult, ConverseTurn, KnownState } from './planConverse';

const ROUND_TRIP_WORDS =
  /\b(round[\s-]?trips?|return\s+(trip|flight|ticket)s?|one[\s-]?way|RT|back\s+home|(fly|flying|head|heading|go|going|come|coming|get|getting|travel|traveling|travelling)\s+home|return(ing)?\s+home|not\s+(coming|going|flying)\s+back|no\s+return)\b/i;
const ONE_WAY_WORDS = /\b(one[\s-]?way|not\s+(coming|going|flying)\s+back|no\s+return)\b/i;
const AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|correct|right|that'?s right|exactly|sure|it is|home)\b/i;

/** Did this message say round-trip or one-way (or back home)? */
export function saysRoundTripOrOneWay(message: string): boolean {
  return ROUND_TRIP_WORDS.test(message);
}

/** true / false for a message that plainly answers round-trip vs one-way; null otherwise. */
export function roundTripAnswer(message: string): boolean | null {
  if (!saysRoundTripOrOneWay(message)) return null;
  return !ONE_WAY_WORDS.test(message);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the message say `city` is where they live / are based / are now? */
export function saysThisIsHome(message: string, city: string): boolean {
  const c = escapeRegex(city.trim());
  if (!c) return false;
  const patterns = [
    `\\b(i|we)\\s*(?:'|’)?\\s*(?:m|re|am|are)\\s+(?:from|in|based\\s+in|living\\s+in|located\\s+in)\\s+${c}\\b`,
    `\\b(i|we)\\s+(?:live|stay|reside)\\s+in\\s+${c}\\b`,
    `\\b(?:based|living|located)\\s+(?:in|out\\s+of)\\s+${c}\\b`,
    `\\b(?:my|our)\\s+home\\s+(?:is|city\\s+is)\\s+(?:in\\s+)?${c}\\b`,
    `\\bhome\\s+is\\s+(?:in\\s+)?${c}\\b`,
    `\\b${c}\\s+is\\s+(?:my\\s+|our\\s+)?home\\b`,
  ];
  return patterns.some((p) => new RegExp(p, 'i').test(message));
}

/** Was this (assistant) message asking where they fly from? */
export function askedWhereFrom(message: string): boolean {
  return (
    /\bfrom\b/i.test(message) &&
    /\b(fly|flying|flight|start|starting|leav\w*|depart\w*|coming|based|home|travel\w*)\b/i.test(message) &&
    /\?/.test(message)
  );
}

function sameCity(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The model's reply with any wrap-up, question or guess about home/return removed; '' if nothing is left. */
export function acknowledgement(reply: string): string {
  const sentences = reply.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const kept = sentences.filter(
    (x) =>
      !x.endsWith('?') &&
      !/everything|find my trip|give it a look|all set|ready to go|starting (from|out)|flying (from|out of|in)|you'?re from|depart|round[\s-]?trip|one[\s-]?way|multi-city route/i.test(x),
  );
  return kept.slice(0, 2).join(' ');
}

function withAck(reply: string, question: string): string {
  const ack = acknowledgement(reply);
  return ack ? `${ack} ${question}` : question;
}

export function confirmOriginQuestion(city: string): string {
  return `Just to check — are you flying from ${city}, or starting the trip there after flying in from somewhere else?`;
}

export function roundTripQuestion(origin: string | null): string {
  return origin
    ? `Last thing — are you flying back to ${origin} at the end (round-trip), or one-way?`
    : 'Last thing — is this a round-trip, or one-way?';
}

/**
 * Apply the rules to one converse turn. `result` is what the model returned
 * (updates already normalised); the return value is what the client gets.
 */
export function guardHomeAnswers(params: {
  message: string;
  history: ConverseTurn[];
  known: KnownState;
  result: ConverseResult;
}): ConverseResult {
  const { message, history, known } = params;
  const updates = { ...params.result.updates };
  let { reply, action, quickReplies } = params.result;

  // ── Round-trip vs one-way: only when they said so ──
  if (typeof updates.returnToHome === 'boolean' && !saysRoundTripOrOneWay(message)) {
    delete updates.returnToHome;
  } else if (typeof updates.returnToHome !== 'boolean') {
    // "Round-trip" / "One-way" tapped or typed, and the model left it out.
    const answer = roundTripAnswer(message);
    if (answer !== null && typeof known.returnToHome !== 'boolean') updates.returnToHome = answer;
  }

  // ── Where they fly from: said it's home, answered our question, or corrected it ──
  const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant')?.content ?? '';
  let originToConfirm: string | null = null;
  if (typeof updates.origin === 'string' && updates.origin.trim() && !sameCity(updates.origin, known.origin)) {
    const city = updates.origin.trim();
    const named = new RegExp(`\\b${escapeRegex(city)}\\b`, 'i');
    const correction = !!known.origin && new RegExp(`\\b(from|out\\s+of)\\s+${escapeRegex(city)}\\b`, 'i').test(message);
    // An answer to "where are you flying from?" counts only if it names the
    // city, or is a plain yes to a question that named it. Live, "Round-trip"
    // sent after "…or is Paris where you're based?" was taken as Paris.
    const answered =
      askedWhereFrom(lastAssistant) &&
      (named.test(message) || (AFFIRMATIVE.test(message) && named.test(lastAssistant)));
    if (!saysThisIsHome(message, city) && !answered && !correction) {
      originToConfirm = city;
      delete updates.origin;
    }
  } else if (!known.origin && typeof updates.origin !== 'string' && askedWhereFrom(lastAssistant)) {
    // "Yes, from Paris" tapped, and the model left the origin out.
    const m = /^\s*yes[,!.]?\s+(?:i'?m\s+|we'?re\s+)?(?:flying\s+)?from\s+(.+?)[.!]?\s*$/i.exec(message);
    if (m) updates.origin = m[1].trim();
  }

  if (originToConfirm && action !== 'show_city_picker' && action !== 'redirect') {
    return {
      reply: withAck(reply, confirmOriginQuestion(originToConfirm)),
      updates,
      action: 'ask',
      quickReplies: [`Yes, from ${originToConfirm}`, 'Flying in from somewhere else'],
      asking: 'origin',
    };
  }

  // ── Not finished while either is unknown ──
  const origin = (typeof updates.origin === 'string' && updates.origin) || known.origin || null;
  const roundTrip = typeof updates.returnToHome === 'boolean' ? updates.returnToHome : known.returnToHome;
  const vibeKnown = !!(updates.vibe ?? known.vibe);
  const budgetKnown = (updates.budget ?? known.budget) != null;
  const finishing =
    action === 'ready' ||
    (action === 'show_vibe_picker' && vibeKnown) ||
    (action === 'show_budget_slider' && budgetKnown);
  if (finishing && !origin) {
    return { reply: withAck(reply, 'Where are you flying from?'), updates, action: 'ask', quickReplies: undefined, asking: 'origin' };
  }
  if (finishing && typeof roundTrip !== 'boolean') {
    return { reply: withAck(reply, roundTripQuestion(origin)), updates, action: 'ask', quickReplies: ['Round-trip', 'One-way'], asking: 'returnToHome' };
  }
  // Nor is it stated as if it were known. Production, after "Paris is
  // home": "Perfect! So you'll be flying round-trip from Paris. How many
  // people are traveling?" — nobody had said round-trip.
  if (typeof roundTrip !== 'boolean') reply = withoutRoundTripClaims(reply);
  return { reply, updates, action, quickReplies, ...(params.result.asking ? { asking: params.result.asking } : {}) };
}

/** The reply without statements (not questions) about round-trip / one-way / flying back. */
export function withoutRoundTripClaims(reply: string): string {
  const sentences = reply.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const kept = sentences.filter((x) => x.endsWith('?') || !/round[\s-]?trip|one[\s-]?way|flying back|fly back|return(ing)? home|back home/i.test(x));
  return kept.length > 0 ? kept.join(' ') : reply;
}
