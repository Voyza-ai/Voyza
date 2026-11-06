import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import { logger } from '../utils/logger';

/**
 * Planning-phase destination revision ("actually Venice not Venezuela").
 *
 * The guided planner asks one question per step. Once the destination step is
 * behind the traveller, anything they type goes to the CURRENT step — so a
 * correction typed at "Where are you starting from?" used to be saved as the
 * origin, and there was no way back. This service decides whether a message
 * is a change to the destination list and, if so, what the new list is.
 *
 * Claude classifies the message with forced tool use (add / remove / replace /
 * answer_only / not_a_revision). The tools only DESCRIBE the change; the new
 * list is computed here, deterministically, so the model can never hand back
 * a list that silently drops a city it was not asked to touch. When Claude is
 * unavailable (no key, timeout, malformed output) a small rule-based parser
 * covers the common phrasings, and anything it does not recognise is treated
 * as "not a revision" — the message then goes to the current step exactly as
 * it did before this feature existed.
 */

export type RevisionOp =
  | { op: 'add'; city: string; after?: string }
  | { op: 'remove'; city: string }
  | { op: 'replace'; from: string; to: string };

export type RevisionChange =
  | { type: 'added'; city: string }
  | { type: 'removed'; city: string }
  | { type: 'replaced'; from: string; to: string };

export type RevisionResult = {
  /** revised: the list changed · answer: a reply only, list unchanged ·
   *  none: not about destinations — the caller handles the message as usual. */
  kind: 'revised' | 'answer' | 'none';
  destinations: string[];
  changes: RevisionChange[];
  reply?: string;
  source: 'ai' | 'rules';
};

export const MAX_DESTINATIONS = 5;

// ─── Matching ────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Index of the destination the user meant, tolerating case, accents and a
 *  small typo ("florance" → Florence). -1 when nothing is close enough. */
export function findDestination(destinations: string[], name: string): number {
  const n = norm(name);
  if (!n) return -1;
  const exact = destinations.findIndex((d) => norm(d) === n);
  if (exact >= 0) return exact;
  // "Rome, Italy" vs "Rome"
  const prefix = destinations.findIndex((d) => {
    const dn = norm(d);
    return dn.startsWith(n + ' ') || n.startsWith(dn + ' ');
  });
  if (prefix >= 0) return prefix;
  let best = -1;
  let bestDist = Infinity;
  destinations.forEach((d, i) => {
    const dist = editDistance(norm(d), n);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  // Typo tolerance scales with length: short names must match exactly
  // ("Rice" is not "Nice"), 5-6 letters allow one slip, longer allow two.
  const limit = n.length <= 4 ? 0 : n.length <= 6 ? 1 : 2;
  return bestDist <= limit ? best : -1;
}

function cleanCity(raw: string): string {
  const trimmed = raw
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.!?,;:]+$/g, '')
    .replace(/^(the city of|to|in|visit|visiting)\s+/i, '')
    .trim();
  // Keep the user's capitalisation when they used any; otherwise title-case.
  if (/[A-Z]/.test(trimmed)) return trimmed;
  return trimmed.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ─── Applying ────────────────────────────────────────────────────────

/**
 * Apply ops in order to a copy of the list. Ops that cannot apply (removing a
 * city that is not on the trip, adding a duplicate, removing the last city)
 * are skipped and reported back so the reply can say so.
 */
export function applyRevisionOps(
  destinations: string[],
  ops: RevisionOp[],
): { destinations: string[]; changes: RevisionChange[]; problems: string[] } {
  const list = [...destinations];
  const changes: RevisionChange[] = [];
  const problems: string[] = [];

  for (const op of ops) {
    if (op.op === 'remove') {
      const i = findDestination(list, op.city);
      if (i < 0) {
        problems.push(`${cleanCity(op.city)} isn't on the trip`);
        continue;
      }
      if (list.length === 1) {
        problems.push(`a trip needs at least one city, so ${list[0]} stays until you name another`);
        continue;
      }
      changes.push({ type: 'removed', city: list[i] });
      list.splice(i, 1);
    } else if (op.op === 'add') {
      const city = cleanCity(op.city);
      if (!city) continue;
      if (findDestination(list, city) >= 0 && norm(list[findDestination(list, city)]) === norm(city)) {
        problems.push(`${city} is already on the trip`);
        continue;
      }
      if (list.length >= MAX_DESTINATIONS) {
        problems.push(`a trip can have up to ${MAX_DESTINATIONS} cities`);
        continue;
      }
      const afterIdx = op.after ? findDestination(list, op.after) : -1;
      if (afterIdx >= 0) list.splice(afterIdx + 1, 0, city);
      else list.push(city);
      changes.push({ type: 'added', city });
    } else {
      const i = findDestination(list, op.from);
      const to = cleanCity(op.to);
      if (!to) continue;
      if (i < 0) {
        // "Venice not Venezuela" where Venezuela was never on the list is
        // still an add of the city they actually want — but only when the
        // list is a single city, where the intent is unambiguous.
        if (list.length === 1) {
          changes.push({ type: 'replaced', from: list[0], to });
          list[0] = to;
        } else {
          problems.push(`${cleanCity(op.from)} isn't on the trip`);
        }
        continue;
      }
      if (norm(list[i]) === norm(to)) continue;
      const dup = list.findIndex((d, j) => j !== i && norm(d) === norm(to));
      changes.push({ type: 'replaced', from: list[i], to });
      if (dup >= 0) list.splice(i, 1);
      else list[i] = to;
    }
  }
  return { destinations: list, changes, problems };
}

export function describeChanges(changes: RevisionChange[], problems: string[], destinations: string[]): string {
  const parts = changes.map((c) =>
    c.type === 'added'
      ? `added ${c.city}`
      : c.type === 'removed'
        ? `removed ${c.city}`
        : `swapped ${c.from} for ${c.to}`,
  );
  const list = destinations.join(', ');
  let reply = parts.length
    ? `Done — ${joinAnd(parts)}. Your trip is now ${list}.`
    : `Your trip is still ${list}.`;
  if (problems.length) reply += ` (I left it there because ${joinAnd(problems)}.)`;
  return reply;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ─── Rule-based fallback ─────────────────────────────────────────────

const LEAD = /^(?:(?:oh|oops|sorry|wait|no|hmm|ok|okay)[,!.]?\s+)*(?:actually|i meant|i mean|make (?:it|that)|sorry,?|please)?[,\s]*/i;

/**
 * The phrasings people actually use for a destination fix. Deliberately
 * narrow: a false positive here would swallow an answer to the current
 * question, which is worse than missing a revision (the user can rephrase).
 */
export function ruleBasedOps(message: string, destinations: string[]): RevisionOp[] | null {
  const text = message.trim().replace(LEAD, '').trim();
  if (!text) return null;

  // "replace/swap/switch/change X with/for/to Y"
  let m = text.match(/^(?:replace|swap|switch|change)\s+(.+?)\s+(?:with|for|to|into)\s+(.+)$/i);
  if (m && findDestination(destinations, m[1]) >= 0) return [{ op: 'replace', from: m[1], to: m[2] }];

  // "Y instead of X" / "instead of X, Y"
  m = text.match(/^(.+?)\s+instead of\s+(.+)$/i);
  if (m && findDestination(destinations, m[2]) >= 0) return [{ op: 'replace', from: m[2], to: m[1] }];
  m = text.match(/^instead of\s+(.+?),?\s+(?:go to\s+|do\s+)?(.+)$/i);
  if (m && findDestination(destinations, m[1]) >= 0) return [{ op: 'replace', from: m[1], to: m[2] }];

  // "Y not X" / "Y, not X"
  m = text.match(/^(.+?),?\s+not\s+(.+)$/i);
  if (m && findDestination(destinations, m[2]) >= 0) return [{ op: 'replace', from: m[2], to: m[1] }];

  // "drop / remove / skip / cut / no X"
  m = text.match(/^(?:drop|remove|skip|cut|delete|lose|no)\s+(.+?)(?:\s+(?:from the (?:trip|list)|please))?$/i);
  if (m && findDestination(destinations, m[1]) >= 0) return [{ op: 'remove', city: m[1] }];

  // "add X (after Y)" / "also X"
  m = text.match(/^(?:add|also add|also|include|plus)\s+(.+?)(?:\s+after\s+(.+?))?(?:\s+(?:to the (?:trip|list)|too|as well|please))?$/i);
  if (m) return [{ op: 'add', city: m[1], ...(m[2] ? { after: m[2] } : {}) }];

  return null;
}

/**
 * Cheap pre-filter the client can mirror: only messages with a revision cue
 * word, or that name a city already on the trip, are worth a model call.
 */
export function mightBeRevision(message: string, destinations: string[]): boolean {
  if (/\b(actually|instead|not|rather|change|swap|switch|replace|drop|remove|skip|cut|add|also|include|plus|meant|mean|typo)\b/i.test(message)) {
    return true;
  }
  const words = norm(message);
  return destinations.some((d) => {
    const dn = norm(d);
    return dn.length > 2 && new RegExp(`\\b${dn}\\b`).test(words);
  });
}

// ─── Claude ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'add_destination',
    description: 'The traveller wants to ADD a city to the trip. One call per city.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'The city to add, correctly spelled (e.g. "Venice").' },
        after: { type: 'string', description: 'Optional: the existing trip city it should come after.' },
      },
      required: ['city'],
    },
  },
  {
    name: 'remove_destination',
    description: 'The traveller wants to REMOVE a city that is currently on the trip.',
    input_schema: {
      type: 'object' as const,
      properties: { city: { type: 'string', description: 'The trip city to remove, as listed.' } },
      required: ['city'],
    },
  },
  {
    name: 'replace_destination',
    description:
      'The traveller wants one trip city swapped for another — including fixing a typo or a wrong guess ("Venice not Venezuela").',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'The trip city being replaced, as listed.' },
        to: { type: 'string', description: 'The city they want instead, correctly spelled.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'answer_only',
    description:
      'The message is ABOUT the destinations but changes nothing yet: a question about them, or an ambiguous request you must clarify (e.g. they named a country — ask which city).',
    input_schema: {
      type: 'object' as const,
      properties: { reply: { type: 'string', description: '1-2 short, warm sentences.' } },
      required: ['reply'],
    },
  },
  {
    name: 'not_a_revision',
    description:
      'The message is NOT about the destination list — it answers the current question (origin, dates, travellers, budget, notes…). Use this whenever in doubt.',
    input_schema: { type: 'object' as const, properties: {} },
  },
];

function systemPrompt(destinations: string[], currentQuestion?: string): string {
  return `You are part of BlueMurr's trip planner. The traveller already chose their destinations and is now answering a later question. Decide whether their latest message changes the DESTINATION LIST.

Current destinations (in order): ${JSON.stringify(destinations)}
The question on screen right now: ${JSON.stringify(currentQuestion ?? 'unknown')}

Rules
- A plain answer to the question on screen is NOT a revision — use not_a_revision. "New York" when asked where they start from is an origin, not a destination. When in doubt, not_a_revision.
- Corrections count: "actually Venice not Venezuela", "I meant Porto", "swap Florence for Bologna", "drop Paris", "add Nice after Lyon".
- "I meant X" with one destination on the trip replaces that destination.
- Cities only. If they name a country or region, use answer_only and ask which city.
- Several changes in one message → call several tools, in the order they said them.
- Never re-add cities that are already on the list. Never invent changes.`;
}

async function aiOps(
  message: string,
  destinations: string[],
  currentQuestion?: string,
): Promise<{ ops: RevisionOp[]; answer?: string; notRevision: boolean } | null> {
  const anthropic = getAnthropicSafe();
  if (!anthropic) return null;
  try {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 400,
      system: systemPrompt(destinations, currentQuestion),
      tools: TOOLS as any,
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: message }],
    });
    const uses = (response.content ?? []).filter((c: any) => c.type === 'tool_use') as any[];
    if (uses.length === 0) {
      logger.warn('reviseDestinations: no tool call');
      return null;
    }
    if (uses.some((u) => u.name === 'not_a_revision')) return { ops: [], notRevision: true };
    const ops: RevisionOp[] = [];
    let answer: string | undefined;
    for (const u of uses) {
      const i = u.input ?? {};
      if (u.name === 'add_destination' && typeof i.city === 'string') {
        ops.push({ op: 'add', city: i.city, ...(typeof i.after === 'string' && i.after ? { after: i.after } : {}) });
      } else if (u.name === 'remove_destination' && typeof i.city === 'string') {
        ops.push({ op: 'remove', city: i.city });
      } else if (u.name === 'replace_destination' && typeof i.from === 'string' && typeof i.to === 'string') {
        ops.push({ op: 'replace', from: i.from, to: i.to });
      } else if (u.name === 'answer_only' && typeof i.reply === 'string') {
        answer = i.reply;
      }
    }
    if (ops.length === 0 && !answer) {
      logger.warn('reviseDestinations: malformed tool input', { got: JSON.stringify(uses).slice(0, 200) });
      return null;
    }
    return { ops, answer, notRevision: false };
  } catch (err: any) {
    logger.warn('reviseDestinations: AI call failed, using rules', {
      status: err?.status ?? err?.statusCode,
      errMessage: err?.message,
    });
    return null;
  }
}

export async function reviseDestinations(params: {
  message: string;
  destinations: string[];
  currentQuestion?: string;
}): Promise<RevisionResult> {
  const { message, destinations, currentQuestion } = params;
  const unchanged = (source: 'ai' | 'rules'): RevisionResult => ({
    kind: 'none',
    destinations,
    changes: [],
    source,
  });

  if (!mightBeRevision(message, destinations)) return unchanged('rules');

  const ai = await aiOps(message, destinations, currentQuestion);
  let source: 'ai' | 'rules' = 'ai';
  let ops: RevisionOp[];
  if (ai) {
    if (ai.notRevision) return unchanged('ai');
    if (ai.ops.length === 0) {
      return { kind: 'answer', destinations, changes: [], reply: ai.answer, source: 'ai' };
    }
    ops = ai.ops;
  } else {
    source = 'rules';
    const ruleOps = ruleBasedOps(message, destinations);
    if (!ruleOps) return unchanged('rules');
    ops = ruleOps;
  }

  const applied = applyRevisionOps(destinations, ops);
  if (applied.changes.length === 0) {
    return {
      kind: 'answer',
      destinations,
      changes: [],
      reply: describeChanges([], applied.problems, destinations),
      source,
    };
  }
  return {
    kind: 'revised',
    destinations: applied.destinations,
    changes: applied.changes,
    reply: describeChanges(applied.changes, applied.problems, applied.destinations),
    source,
  };
}
