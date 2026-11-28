import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import { stripOriginFiller } from './location/originPhrase';
import { AppError } from '../middleware/error';
import { guardHomeAnswers } from './homeAnswers';
import { logger } from '../utils/logger';
import { createMessage } from './aiUsage';

/**
 * The conversational planning brain.
 *
 * One Claude call per user turn: it reads the conversation so far plus the
 * structured "known so far" state, replies like a human travel agent, and
 * extracts any trip facts the user just gave — in any order, several at
 * once, or none. The frontend renders the reply and applies the updates;
 * question ORDER is emergent, not a hardcoded step list.
 *
 * Output structure is guaranteed by forced tool-use (no JSON-in-prose
 * parsing). On any AI failure we throw a typed 503 so the client can show
 * an honest "assistant unreachable" state with a Retry — never a fake
 * "I didn't understand you".
 */

export type ConverseTurn = { role: 'user' | 'assistant'; content: string };

export type KnownState = {
  destinations?: string[];
  origin?: string | null;
  dates?: { start: string; end: string } | null;
  travelers?: number | null;
  budget?: number | null;
  budgetPerPerson?: boolean | null;
  vibe?: string | null;
  returnToHome?: boolean | null;
  notes?: string | null;
};

export type ConverseResult = {
  reply: string;
  updates: {
    destinations?: string[];
    countries?: Array<{ country: string; cities: string[] }>;
    origin?: string | null;
    dates?: { start: string; end: string } | null;
    travelers?: number | null;
    travelersAmbiguous?: boolean;
    budget?: number | null;
    budgetPerPerson?: boolean | null;
    vibe?: string | null;
    returnToHome?: boolean | null;
    notes?: string | null;
  };
  action:
    | 'ask'
    | 'show_city_picker'
    | 'show_vibe_picker'
    | 'show_budget_slider'
    | 'ready'
    | 'redirect';
  quickReplies?: string[];
  /**
   * The one trip fact the reply's question asks for, so the page can offer
   * the matching control (a calendar for dates, "Use my location" for
   * origin). Absent when the reply asks nothing.
   */
  asking?: AskingField;
};

export const ASKING_FIELDS = ['destinations', 'dates', 'origin', 'travelers', 'returnToHome', 'budget', 'vibe', 'other'] as const;
export type AskingField = (typeof ASKING_FIELDS)[number];

const RESPOND_TOOL = {
  name: 'respond_to_traveler',
  description:
    'Your ONLY way to answer. Carries your conversational reply plus any trip facts you extracted from the latest message.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reply: {
        type: 'string',
        description:
          'Your conversational reply — warm, human, 1-3 short sentences. No lists, no headers.',
      },
      updates: {
        type: 'object',
        description:
          'ONLY fields the user explicitly stated in their LATEST message (or a correction to an earlier one). Omit everything unstated — never guess.',
        properties: {
          destinations: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Specific CITY names the user named or corrected. The full desired list if they corrected it ("drop Florence" → list without Florence).',
          },
          countries: {
            type: 'array',
            description:
              'When the user names a COUNTRY (not a city): one entry per country with 4-6 popular cities for the picker.',
            items: {
              type: 'object',
              properties: {
                country: { type: 'string' },
                cities: { type: 'array', items: { type: 'string' } },
              },
              required: ['country', 'cities'],
            },
          },
          origin: {
            type: ['string', 'null'],
            description:
              'The city they fly FROM to START the trip (where they live, or where they will be when it begins), plain name. A US state or region ("New Jersey", "Long Island") is fine as written. A city that is part of the route ("Paris to London, back to Paris, then Munich") is a STOP, not the origin, unless they said it is home.',
          },
          dates: {
            type: ['object', 'null'],
            properties: {
              start: { type: 'string', description: 'YYYY-MM-DD' },
              end: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['start', 'end'],
          },
          travelers: { type: ['number', 'null'], description: 'TOTAL group size incl. the planner.' },
          travelersAmbiguous: {
            type: 'boolean',
            description:
              'true when phrasing like "with 3 people" could mean 3 or 4 total — then ASK in your reply.',
          },
          budget: { type: ['number', 'null'] },
          budgetPerPerson: { type: ['boolean', 'null'] },
          vibe: { type: ['string', 'null'] },
          returnToHome: {
            type: ['boolean', 'null'],
            description:
              'true ONLY if they said round-trip / return flight / back home; false ONLY if they said one-way. "Back to <a trip city>" in the middle of a route is NOT round-trip. Otherwise omit.',
          },
          notes: {
            type: ['string', 'null'],
            description: 'Preferences that fit no other field (dietary, pace, accessibility…).',
          },
        },
      },
      action: {
        type: 'string',
        enum: ['ask', 'show_city_picker', 'show_vibe_picker', 'show_budget_slider', 'ready', 'redirect'],
        description:
          "What the UI should do: 'ask'=plain question; 'show_city_picker'=you provided countries[] and want them to pick cities; 'show_vibe_picker'=you are asking about trip vibe; 'show_budget_slider'=you are asking about budget; 'ready'=minimums met, show the recap; 'redirect'=message was off-topic.",
      },
      asking: {
        type: 'string',
        enum: [...ASKING_FIELDS],
        description:
          "The ONE trip fact your reply's question asks for: 'dates' when you ask when they travel, 'origin' when you ask where they fly FROM, and so on; 'other' for any other question. Omit when your reply asks nothing.",
      },
      quickReplies: {
        type: 'array',
        items: { type: 'string' },
        description: '0-4 short tappable answers to YOUR question (e.g. "Just me", "2 of us"). Omit when not a simple question.',
      },
    },
    required: ['reply', 'updates', 'action'],
  },
};

function systemPrompt(known: KnownState, userLocation?: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `You are BlueMurr's trip planner — a warm, sharp human travel agent in chat form. The traveler talks; you listen, extract, and move the plan forward. You are NOT a form: never march through a fixed question list.

Today's date: ${today} (UTC). Traveler's location: ${userLocation ?? 'unknown'}.

WHAT YOU KNOW SO FAR (never re-ask these):
${JSON.stringify(known, null, 2)}

CONVERSATION RULES
- Reply like a person: 1-3 short sentences, specific, no bullet lists.
- Extract EVERY fact present in their latest message into updates — several at once is normal. Only explicitly stated facts; never infer or default.
- The user may change ANY earlier answer at ANY time ("actually 3 weeks", "swap Florence for Bologna") — put the corrected value in updates and acknowledge naturally.
- Ask about exactly ONE missing thing per turn, in whatever order the conversation makes natural. Vary your phrasing; never sound templated.
- If they ask a travel question ("is October good for Italy?"), ANSWER it helpfully first, then steer back.
- Anything non-travel: one friendly line steering back to the trip; action 'redirect'; no updates.
- Ambiguous group size ("with 3 friends") → set travelersAmbiguous and ask which they meant.

EXTRACTION RULES
- destinations: specific cities only. A COUNTRY mention goes in countries[] with 4-6 popular cities, action 'show_city_picker'. A city the route starts in or returns to mid-trip ("Paris to London, back to Paris, then Munich") is a stop: include it.
- dates: resolve relative phrases ("next month", "this summer") to YYYY-MM-DD using today's date. Trip dates are always in the future: a date without a year ("Dec 10") means its next occurrence after today. Duration without a start ("10 days in June") → pick a sensible start in that window and say so.
- travelers: TOTAL group size including the planner ("me and 3 friends" → 4).
- budget: number + whether per-person.
- origin: where they fly FROM to start the trip. A route that begins in a city ("flying out of Paris to London…") does NOT tell you they live there — they may be flying in from elsewhere. Unless they said it's home ("I live in Paris", "we're based in Paris"), ASK: "Are you flying from Paris, or starting the trip there after flying in from somewhere else?" with quickReplies ["Yes, from Paris", "Flying in from somewhere else"]. If they fly in from elsewhere, ask where from.
- returnToHome: only when they said round-trip / one-way / back home. Never infer it from a route; "back to Paris" mid-trip is a stop, not a return home.

FLOW
- Minimum to finish (ALL five required): ≥1 destination city, dates, travelers, origin (the city they're flying FROM), AND round-trip vs one-way. Origin is NOT optional — without it there's no departure point for the flight search, so ALWAYS ask "where are you flying from?" if it's still unknown, before you ever go 'ready'. Round-trip vs one-way is NOT optional either: if returnToHome is still unknown, ask "Are you flying back to <origin> at the end, or one-way?" with quickReplies ["Round-trip", "One-way"]. Budget and vibe: worth ONE ask each; respect a skip ("no budget" → budget stays null, move on, never ask again — note the skip in notes as "budget: skipped" style).
- Non-null fields in KNOWN are settled facts the user already provided (possibly via UI controls rather than chat). NEVER re-ask for them, NEVER claim you don't have them, and NEVER return a different or empty value for them in updates — leave a field out (or null) unless THIS message changes it.
- 'show_budget_slider' / 'show_vibe_picker' mean "I am ASKING for this field and it is still unknown". NEVER use them when the latest message already ANSWERS that field — "culture vibes" answers vibe: extract updates.vibe='culture' and move ON (never show the vibe picker back at them; same for a stated budget number and the slider).
- After extracting, re-check completeness against KNOWN + your updates: if destinations, dates, travelers, origin AND returnToHome are all present and you've already covered (asked or been told) budget and vibe, the action is 'ready' — not another question. If origin or returnToHome is still missing, ask for it (action 'ask') no matter what else is done.
- When the minimums are met (including anything just provided), action 'ready' and a short wrap-up line like "That's everything I need — give it a look and hit Find my trip." The UI shows the recap; do NOT recite every detail yourself.
- After 'ready', if they change something, apply the update and go 'ready' again (or ask, if the change opened a gap).

Always respond via the respond_to_traveler tool. Never plain text.`;
}

export async function converse(params: {
  message: string;
  history: ConverseTurn[];
  known: KnownState;
  userLocation?: string;
}): Promise<ConverseResult> {
  const anthropic = getAnthropicSafe();
  if (!anthropic) {
    throw new AppError(503, 'assistant_unavailable', { reason: 'no_api_key' });
  }

  const { message, history, known, userLocation } = params;

  try {
    const response = await createMessage(anthropic, 'plan_converse', {
      model: DEFAULT_MODEL,
      max_tokens: 700,
      system: systemPrompt(known, userLocation),
      tools: [RESPOND_TOOL as any],
      tool_choice: { type: 'tool', name: 'respond_to_traveler' },
      messages: [
        ...history.slice(-16).map((t) => ({ role: t.role, content: t.content })),
        { role: 'user' as const, content: message },
      ],
    });

    const toolUse = response.content.find((c: any) => c.type === 'tool_use') as any;
    const input = toolUse?.input;
    if (!input || typeof input.reply !== 'string' || typeof input.action !== 'string') {
      logger.warn('converse: malformed tool output', { got: JSON.stringify(input)?.slice(0, 200) });
      throw new AppError(503, 'assistant_unavailable', { reason: 'malformed_output' });
    }

    // The model sometimes emits "" instead of null for string fields it has
    // no value for. An empty string is NOT an update — passing it through
    // lets it overwrite facts the user already gave (a detected origin was
    // erased this way and the planner re-asked for it). Empty → null.
    const updates = { ...(input.updates ?? {}) };
    for (const key of ['origin', 'vibe', 'notes'] as const) {
      if (typeof updates[key] === 'string' && updates[key].trim() === '') {
        updates[key] = null;
      }
    }
    // "from New Jersey" -> "New Jersey": the origin lookup reads this string.
    if (typeof updates.origin === 'string') updates.origin = stripOriginFiller(updates.origin) || null;

    // Where they fly from and whether they fly back are asked, never
    // guessed (homeAnswers.ts): the model read "flying out of Paris to
    // London…" as home = Paris and invented one-way, and never asked.
    return guardHomeAnswers({
      message,
      history,
      known,
      result: {
        reply: input.reply,
        updates,
        action: input.action,
        quickReplies: Array.isArray(input.quickReplies) ? input.quickReplies.slice(0, 4) : undefined,
        ...((ASKING_FIELDS as readonly string[]).includes(input.asking) ? { asking: input.asking as AskingField } : {}),
      },
    });
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    logger.error('converse: AI call failed', {
      status: err?.status ?? err?.statusCode,
      errMessage: err?.message,
    });
    throw new AppError(503, 'assistant_unavailable', { reason: 'ai_error' });
  }
}
