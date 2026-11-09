import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';
import { checkCityName } from './cityEdit';

/**
 * Planning-phase destination revision: POST /api/plan/revise-destinations.
 *
 * The guided planner asks one question at a time, and once the destination
 * step is behind it, anything typed goes to the CURRENT question — so
 * "actually Venice not Venezuela" typed at the dates step was read as a date,
 * and there was no way back to the destination answer (ROADMAP bug: "no way
 * to correct a destination typo once submitted").
 *
 * This endpoint only ever touches the destination list. The model reads the
 * message against the current list and calls tools; the edits are applied
 * here, deterministically, and the new list is returned. Dates, budget, vibe
 * and every other answer stay exactly where the client keeps them — they are
 * never sent back, so they cannot be lost.
 *
 * Tools: add_destination, remove_destination, replace_destination and
 * answer_only. Several tool calls in one turn are applied in order
 * ("swap Venezuela for Venice and add Rome").
 */

export type DestinationChange =
  | { kind: 'add'; city: string; afterCity?: string; beforeCity?: string }
  | { kind: 'remove'; city: string }
  | { kind: 'replace'; from: string; to: string };

export type RevisionResult =
  | { type: 'revision'; reply: string; destinations: string[]; changes: DestinationChange[] }
  | {
      type: 'answer';
      reply: string;
      /**
       * False when the message wasn't about destinations at all (e.g. "I meant
       * 2 people" typed at the travelers step): the client then hands it to
       * the current question as if this endpoint had never been asked.
       */
      aboutDestinations: boolean;
    };

export const REVISION_TOOLS = [
  {
    name: 'add_destination',
    description: 'Add a city to the destination list ("add Rome too", "and Florence").',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City to add, plain English name.' },
        afterCity: { type: ['string', 'null'], description: 'Existing destination it goes after; omit for the end.' },
        beforeCity: {
          type: ['string', 'null'],
          description: 'Existing destination it goes right BEFORE ("before Florence", "start with Rome"). Set this or afterCity, not both.',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'remove_destination',
    description: 'Remove a city from the destination list ("drop Milan", "skip Paris").',
    input_schema: {
      type: 'object' as const,
      properties: { city: { type: 'string', description: 'Exact destination name as listed.' } },
      required: ['city'],
    },
  },
  {
    name: 'replace_destination',
    description:
      'Swap a listed destination for another city — corrections and typos included ("actually Venice not Venezuela", "I meant Porto, not Paris", "Lisbon instead of Madrid").',
    input_schema: {
      type: 'object' as const,
      properties: {
        old: { type: 'string', description: 'Exact destination name as listed.' },
        new: { type: 'string', description: 'The city that takes its place, plain English name.' },
      },
      required: ['old', 'new'],
    },
  },
  {
    name: 'answer_only',
    description:
      'Use when no destination change is asked for: a question, an ambiguous request you need to clarify, or a message about something else entirely (dates, people, budget…).',
    input_schema: {
      type: 'object' as const,
      properties: {
        answer: { type: 'string', description: '1-2 short sentences: the answer or the clarifying question.' },
        aboutDestinations: {
          type: 'boolean',
          description:
            'true if the message is about the destination list (a question or an unclear change); false if it is about something else, such as an answer to the current question.',
        },
      },
      required: ['answer', 'aboutDestinations'],
    },
  },
];

function systemPrompt(destinations: string[], currentQuestion?: string): string {
  return `You are BlueMurr's trip planner. The traveler already gave their destinations and is now answering other questions. Their latest message may be correcting the destination list.

CURRENT DESTINATIONS (in order): ${JSON.stringify(destinations)}
${currentQuestion ? `THE QUESTION ON SCREEN RIGHT NOW: "${currentQuestion}"\n` : ''}
RULES
- Only the destination list is yours to change. Never touch dates, budget, vibe, travelers.
- A correction of a listed destination ("actually Venice not Venezuela", "I meant Nice", "oops, Porto") is replace_destination with old = the exact listed name. If they don't say which one and there are several, pick the one the correction obviously fixes (a similar spelling); if it's truly unclear, answer_only and ask. A listed city may have come from a COUNTRY the traveler mistyped and then picked cities in (typed "Venezuela" meaning Venice → list holds "Caracas"): "Venice not Venezuela" then replaces that city.
- Destinations must be specific CITIES. If they name a country or region ("add Spain"), answer_only and ask which city.
- Several changes in one message → call several tools, in order.
- A message that is just an answer to the question on screen ("4", "June 3-10", "$2000", "no layovers please") or about anything other than destinations → answer_only with aboutDestinations=false and an empty-ish answer.
- Never call a change tool for a city that is already in the list (add) or not in the list (remove/replace old).`;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Apply the model's tool calls to the list, refusing the ones that don't fit. */
export function applyDestinationOps(
  start: string[],
  calls: Array<{ name: string; input: any }>,
): { destinations: string[]; changes: DestinationChange[]; problems: string[] } {
  const list = [...start];
  const changes: DestinationChange[] = [];
  const problems: string[] = [];
  const find = (c: unknown) => (typeof c === 'string' ? list.findIndex((d) => norm(d) === norm(c)) : -1);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  for (const call of calls) {
    const input = call.input ?? {};
    if (call.name === 'add_destination') {
      const city = str(input.city);
      if (!city) continue;
      if (find(city) >= 0) {
        problems.push(`${city} is already on your list`);
        continue;
      }
      const check = checkCityName(city, list);
      if (!check.ok) {
        problems.push(check.reply);
        continue;
      }
      const before = str(input.beforeCity);
      const bAt = before ? find(before) : -1;
      const after = str(input.afterCity);
      const at = bAt < 0 && after ? find(after) : -1;
      if (bAt >= 0) {
        changes.push({ kind: 'add', city, beforeCity: list[bAt] });
        list.splice(bAt, 0, city);
      } else {
        if (at >= 0) list.splice(at + 1, 0, city);
        else list.push(city);
        changes.push(at >= 0 ? { kind: 'add', city, afterCity: list[at] } : { kind: 'add', city });
      }
    } else if (call.name === 'remove_destination') {
      const at = find(input.city);
      if (at < 0) {
        problems.push(`${str(input.city) || 'That city'} isn't on your list`);
        continue;
      }
      if (list.length === 1) {
        problems.push(`${list[0]} is your only destination, so I kept it — tell me which city to swap in instead`);
        continue;
      }
      const [gone] = list.splice(at, 1);
      changes.push({ kind: 'remove', city: gone });
    } else if (call.name === 'replace_destination') {
      const at = find(input.old);
      const to = str(input.new);
      if (at < 0) {
        problems.push(`${str(input.old) || 'That city'} isn't on your list`);
        continue;
      }
      if (!to) continue;
      if (norm(to) === norm(list[at])) continue;
      if (find(to) >= 0) {
        problems.push(`${to} is already on your list`);
        continue;
      }
      const check = checkCityName(to, list.filter((_, i) => i !== at));
      if (!check.ok) {
        problems.push(check.reply);
        continue;
      }
      changes.push({ kind: 'replace', from: list[at], to });
      list[at] = to;
    }
  }
  return { destinations: list, changes, problems };
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeChanges(changes: DestinationChange[]): string {
  return changes
    .map((c) =>
      c.kind === 'replace'
        ? `${c.to} instead of ${c.from}`
        : c.kind === 'remove'
          ? `${c.city} removed`
          : `${c.city} added${c.beforeCity ? ` before ${c.beforeCity}` : c.afterCity ? ` after ${c.afterCity}` : ''}`,
    )
    .join(', ');
}

const sentence = (s: string) => (/[.?!]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export async function reviseDestinations(params: {
  message: string;
  destinations: string[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentQuestion?: string;
}): Promise<RevisionResult> {
  const anthropic = getAnthropicSafe();
  if (!anthropic) throw new AppError(503, 'assistant_unavailable', { reason: 'no_api_key' });

  const { message, destinations, history = [], currentQuestion } = params;
  let response: any;
  try {
    response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 500,
      system: systemPrompt(destinations, currentQuestion),
      tools: REVISION_TOOLS as any,
      tool_choice: { type: 'any' },
      messages: [
        ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
        { role: 'user' as const, content: message },
      ],
    });
  } catch (err: any) {
    logger.error('revise-destinations: AI call failed', { status: err?.status, errMessage: err?.message });
    throw new AppError(503, 'assistant_unavailable', { reason: 'ai_error' });
  }

  const calls = (response?.content ?? []).filter((b: any) => b.type === 'tool_use') as Array<{ name: string; input: any }>;
  if (calls.length === 0) {
    throw new AppError(503, 'assistant_unavailable', { reason: 'malformed_output' });
  }
  const edits = calls.filter((c) => c.name !== 'answer_only');
  const answer = calls.find((c) => c.name === 'answer_only');

  if (edits.length === 0) {
    const text = typeof answer?.input?.answer === 'string' ? answer.input.answer.trim() : '';
    return {
      type: 'answer',
      reply: text || 'Which destination would you like to change?',
      aboutDestinations: answer?.input?.aboutDestinations !== false,
    };
  }

  const { destinations: next, changes, problems } = applyDestinationOps(destinations, edits);
  const problemText = problems.map(sentence).join(' ');
  if (changes.length === 0) {
    return { type: 'answer', reply: problemText || 'Your destinations are unchanged.', aboutDestinations: true };
  }
  const reply = [`Got it — ${describeChanges(changes)}. You're going to ${listPhrase(next)}.`, problemText]
    .filter(Boolean)
    .join(' ');
  return { type: 'revision', reply, destinations: next, changes };
}
