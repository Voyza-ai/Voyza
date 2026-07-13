import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';

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
};

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
          origin: { type: ['string', 'null'], description: 'Home/departure city, plain name.' },
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
          returnToHome: { type: ['boolean', 'null'] },
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
  return `You are Voyza's trip planner — a warm, sharp human travel agent in chat form. The traveler talks; you listen, extract, and move the plan forward. You are NOT a form: never march through a fixed question list.

Today's date: ${today}. Traveler's location: ${userLocation ?? 'unknown'}.

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
- destinations: specific cities only. A COUNTRY mention goes in countries[] with 4-6 popular cities, action 'show_city_picker'.
- dates: resolve relative phrases ("next month", "this summer") to YYYY-MM-DD using today's date. Duration without a start ("10 days in June") → pick a sensible start in that window and say so.
- travelers: TOTAL group size including the planner ("me and 3 friends" → 4).
- budget: number + whether per-person; origin: their departure city; returnToHome: round-trip vs one-way if stated.

FLOW
- Minimum to finish (ALL four required): ≥1 destination city, dates, travelers, AND origin (the city they're flying FROM). Origin is NOT optional — without it there's no departure point for the flight search, so ALWAYS ask "where are you flying from?" if it's still unknown, before you ever go 'ready'. Budget and vibe: worth ONE ask each; respect a skip ("no budget" → budget stays null, move on, never ask again — note the skip in notes as "budget: skipped" style).
- 'show_budget_slider' / 'show_vibe_picker' mean "I am ASKING for this field and it is still unknown". NEVER use them when the latest message already ANSWERS that field — "culture vibes" answers vibe: extract updates.vibe='culture' and move ON (never show the vibe picker back at them; same for a stated budget number and the slider).
- After extracting, re-check completeness against KNOWN + your updates: if destinations, dates, travelers AND origin are all present and you've already covered (asked or been told) budget and vibe, the action is 'ready' — not another question. If origin is still missing, ask for it (action 'ask') no matter what else is done.
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
    const response = await anthropic.messages.create({
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

    return {
      reply: input.reply,
      updates: input.updates ?? {},
      action: input.action,
      quickReplies: Array.isArray(input.quickReplies) ? input.quickReplies.slice(0, 4) : undefined,
    };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    logger.error('converse: AI call failed', {
      status: err?.status ?? err?.statusCode,
      errMessage: err?.message,
    });
    throw new AppError(503, 'assistant_unavailable', { reason: 'ai_error' });
  }
}
