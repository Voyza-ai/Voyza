/**
 * BlueMurr AI chat — the core behind POST /api/plan/chat.
 *
 * ── Service seam (stable; the iMessage bot calls this too) ──────────────
 *
 *   runTripChat({ message, currentTrip, history? }) → Promise<TripChatResult>
 *
 *   in   message      the user's new message (string, non-empty)
 *        currentTrip  the trip as the results page holds it (frontend `Trip`:
 *                     cities[], origin { city, airports, outboundLeg,
 *                     returnLeg, … }, travelers, totalCost = the header total)
 *        history      prior turns, oldest first, [{ role: 'user'|'assistant',
 *                     content }]; NOT including `message`
 *   out  one of (every variant has `reply`, plain text for the user):
 *        { type: 'answer' }                                  nothing to apply
 *        { type: 'proposal', proposal }                      Accept / Reject;
 *              proposal.kind: 'date_shift' | 'city_edit' | 'transport_change'
 *        { type: 'leg_refresh', refresh }                    inter-city card
 *              options replaced (applied without Accept, as before)
 *        { type: 'leg_options', legOptions }                 options added to a
 *              leg's card; the selection and total do not change
 *        { type: 'mode_comparison', comparison }             informational
 *
 *   Never throws for an AI or search failure: those come back as an 'answer'
 *   saying so. Nothing here writes anywhere; applying a proposal is the
 *   caller's job (frontend lib/transportChange.ts, lib/cityEdit.ts).
 *
 * ────────────────────────────────────────────────────────────────────────
 *
 * Claude gets the trip (home, cities, every leg with its id and the options
 * on its card) plus the constraints and history, and picks ONE tool. Every
 * change is proposed from searched, checked data, and the reply describing it
 * is written from that data — never from the model's own text, which is
 * written before anything was searched (D-07).
 */
import { logger } from '../utils/logger';
import { todayIso } from '../utils/dates';
import {
  applyDateConstraints,
  isIsoDate,
  MAX_STAY_NIGHTS,
  mergeConstraints,
  minDaysProblem,
  parseMinNights,
  pinProblem,
  scheduleProblem,
  TripConstraints,
} from './constraints';
import { searchLegOptions, LegOption, normalizeTimeWindow, NormalizedTimeWindow } from './legOptions';
import { compareLeg } from './compareLeg';
import { buildCityEditProposal, cityEditOpFromTool, type CityEditProposal } from './cityEdit';
import { getCityCountry } from '../data/cityCountries';
import { parseDurationMinutes } from '../utils/duration';
import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import {
  buildTransportProposal,
  describeChoice,
  describeRequest,
  describeTransportProposal,
  legLabel,
  legPhrase,
  type LegChoice,
  type LegLookup,
  listLegs,
  matchingChoices,
  money,
  notALegReply,
  readRequest,
  requestProblem,
  resolveLeg,
  searchLeg,
  shortDate,
  signedMoney,
  tripContextForChat,
  tripLegs,
  type ChoiceRequest,
  type TransportChangeProposal,
  type TripLeg,
  verifyTransportProposal,
  whichLegReply,
} from './tripLegs';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type TripChatInput = {
  message: string;
  currentTrip: any;
  history?: ChatTurn[];
};

/** Options found for a leg, added to its card (selection unchanged). */
export type LegOptionsPayload = {
  leg: TransportChangeProposal['leg'];
  /** Matches, cheapest first. */
  options: LegChoice[];
  /** Matches found in all (options may be the first few). */
  totalFound: number;
};

export type TripChatResult =
  | { type: 'answer'; reply: string }
  | { type: 'proposal'; reply: string; proposal: any }
  | { type: 'leg_refresh'; reply: string; refresh: any }
  | { type: 'leg_options'; reply: string; legOptions: LegOptionsPayload }
  | { type: 'mode_comparison'; reply: string; comparison: any };

const legParam = {
  type: 'string',
  description:
    'The leg\'s id exactly as in TRIP CONTEXT legs[].id, e.g. "home→Paris", "Paris→London", "London→home". Home legs are legs too.',
};
const fromParam = { type: 'string', description: 'Origin (a trip city, or "home"). Optional when `leg` is given.' };
const toParam = { type: 'string', description: 'Destination (a trip city, or "home"). Optional when `leg` is given.' };
const timeParam = (what: string) => ({
  type: ['string', 'null'],
  description: `HH:MM 24-hour ${what}, or null.`,
});

/**
 * Claude tool definitions. Tool names are snake_case to match Anthropic's
 * naming convention in examples.
 */
export const CHAT_TOOLS = [
  {
    name: 'answer_only',
    description:
      'Use when the user is asking a question, seeking an explanation, or making small talk — NOT requesting a change to the trip. Examples: "Why is this trip cheaper?", "Why this order of cities?", "What\'s the weather like in Rome in March?".',
    input_schema: {
      type: 'object' as const,
      properties: {
        answer: {
          type: 'string',
          description:
            'The direct answer to the user, written in the voice of a helpful travel planner. 2-4 sentences, concrete, references specific cities/prices/legs from the trip when relevant.',
        },
      },
      required: ['answer'],
    },
  },
  {
    name: 'ask_which_leg',
    description:
      'Use when the user wants to change or see a flight/train but did not say which leg, and the trip has more than one leg (counting the flights to and from home). Example: "change my flight", "find me a later flight". The reply lists every leg for them to choose.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'select_transport_option',
    description:
      'Switch a leg to ONE specific option already listed in that leg\'s cardOptions — "switch to the British Airways one", "take the 19:25", "the second option", "the cheapest one on the card". Pass the leg id and that option\'s optionId. The user sees the change with its exact price difference and must Accept it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leg: legParam,
        optionId: { type: 'string', description: 'The optionId from that leg\'s cardOptions, e.g. "London→home#2".' },
      },
      required: ['leg', 'optionId'],
    },
  },
  {
    name: 'find_transport_option',
    description:
      'Find a different option for a leg described by what it should be — later or earlier than the current one, a time of day ("in the evening"), a time bound, cheaper, a mode, an airline — when it is not already in cardOptions. Searches the leg (home legs search every home airport) and proposes the cheapest option that satisfies everything asked, for the user to Accept. Set list=true when the user asked to SEE options ("show me evening flights home") rather than to change; matching options are then added to the leg\'s card without changing it. If nothing matches, the user is told and nothing changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leg: legParam,
        relative: {
          type: ['string', 'null'],
          enum: ['later', 'earlier', null],
          description: '"later" / "earlier" than the leg\'s current departure, or null.',
        },
        timeOfDay: {
          type: ['string', 'null'],
          enum: ['morning', 'afternoon', 'evening', null],
          description: 'Departure part of day: morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–23:59. Null if not asked.',
        },
        departAfter: timeParam('earliest departure'),
        departBefore: timeParam('latest departure'),
        arriveAfter: timeParam('earliest arrival'),
        arriveBefore: timeParam('latest arrival'),
        cheaper: { type: ['boolean', 'null'], description: 'True if it must cost less than the current option.' },
        mode: { type: ['string', 'null'], enum: ['flight', 'train', null], description: 'Only this mode, or null.' },
        operator: { type: ['string', 'null'], description: 'Airline / rail operator the user named, or null.' },
        list: { type: ['boolean', 'null'], description: 'True when the user asked to see options rather than to change.' },
      },
      required: ['leg'],
    },
  },
  {
    name: 'pin_city_dates',
    description:
      'Lock a city to specific dates. Use when the user says things like "I need to be in Rome March 5-10", "keep me in Tokyo for April 2-7", "schedule Paris for the 15th to 18th". Other cities will be shifted around the pin.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'Exact city name as it appears in the trip.' },
        arrival: { type: 'string', description: 'YYYY-MM-DD arrival date.' },
        departure: { type: 'string', description: 'YYYY-MM-DD departure date.' },
        explanation: {
          type: 'string',
          description: 'One-sentence explanation for the user about what you\'re pinning and why.',
        },
      },
      required: ['city', 'arrival', 'departure', 'explanation'],
    },
  },
  {
    name: 'set_min_days',
    description:
      'Guarantee a minimum number of nights in a city. Use when user says "at least 3 days in Tokyo", "give me 4 nights in Rome minimum", "don\'t rush Florence".',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'Exact city name as it appears in the trip.' },
        minNights: { type: 'number', description: 'Minimum number of nights required.' },
        explanation: {
          type: 'string',
          description: 'One-sentence explanation for the user.',
        },
      },
      required: ['city', 'minNights', 'explanation'],
    },
  },
  {
    name: 'set_transport_window',
    description:
      'Set a time RULE on a leg: "no flights before 5pm from Paris to London", "I need to land by 3pm". Pass null for any bound the user didn\'t specify. For "a later flight", "an evening flight", "something cheaper" use find_transport_option instead. Do NOT use this for "show me more flights" — use show_transport_options for those.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leg: legParam,
        from: fromParam,
        to: toParam,
        earliestDepart: timeParam('earliest departure'),
        latestDepart: timeParam('latest departure'),
        earliestArrive: timeParam('earliest arrival'),
        latestArrive: timeParam('latest arrival'),
        explanation: {
          type: 'string',
          description: 'One-sentence explanation for the user.',
        },
      },
      required: ['explanation'],
    },
  },
  {
    name: 'show_transport_options',
    description:
      'Refresh the transport card for a specific leg with the cheapest flight/train options — no time constraint. Use when the user asks "are there more flights?", "show me trains from X to Y", "what are my options from A to B". REQUIRES a specific leg. If the user is vague about which leg in a multi-leg trip, use ask_which_leg instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leg: legParam,
        from: fromParam,
        to: toParam,
        explanation: {
          type: 'string',
          description: 'One-sentence explanation like "Here are the cheapest options for Rome → Florence".',
        },
      },
      required: ['explanation'],
    },
  },
  {
    name: 'compare_modes',
    description:
      'Surface a side-by-side flight-vs-train comparison for a leg between two trip cities. Use when the user is curious about the OTHER mode without committing to a card change yet — "are there any flights?" (when the leg currently uses train), "what about trains?" (when leg uses flight), "is it cheaper to fly or take the train?". Flights to and from home are flights only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leg: legParam,
        from: fromParam,
        to: toParam,
        explanation: {
          type: 'string',
          description: 'One-sentence framing like "Here\'s flight vs train for Rome → Florence".',
        },
      },
      required: ['explanation'],
    },
  },
  {
    name: 'add_city',
    description:
      'Add a NEW city to the trip. Use when the user says "add Venice", "can we squeeze in Nice after Paris", "add 3 days in Lisbon at the end". The backend prices the new city\'s hotel and the travel in and out, and the user sees a diff to Accept or Reject. Only for a specific city — if the user names a country or region ("add somewhere in Spain"), use answer_only to ask which city.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'The city to add, plain English name ("Venice").' },
        afterCity: {
          type: ['string', 'null'],
          description: 'Existing trip city the new one goes right after. Null/omitted = add it at the end.',
        },
        beforeCity: {
          type: ['string', 'null'],
          description:
            'Existing trip city the new one goes right BEFORE — use for "before Florence", "start with Rome", "at the beginning" (the first city). Set this or afterCity, not both.',
        },
        nights: {
          type: ['number', 'null'],
          description: 'Nights in the new city, only if the user said ("3 days in Lisbon" → 3). Omit otherwise (default 2).',
        },
        explanation: { type: 'string', description: 'One-sentence explanation for the user.' },
      },
      required: ['city', 'explanation'],
    },
  },
  {
    name: 'remove_city',
    description:
      'Remove a city that is in the trip. Use when the user says "drop Florence", "skip Milan", "remove Berlin". Its nights go to the city before it, so the trip dates stay the same.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'Exact city name as it appears in the trip.' },
        explanation: { type: 'string', description: 'One-sentence explanation for the user.' },
      },
      required: ['city', 'explanation'],
    },
  },
  {
    name: 'replace_city',
    description:
      'Swap one trip city for a different one on the same dates. Use when the user says "swap Florence for Bologna", "Naples instead of Rome", "actually Venice not Verona".',
    input_schema: {
      type: 'object' as const,
      properties: {
        old: { type: 'string', description: 'Exact name of the trip city being replaced.' },
        new: { type: 'string', description: 'The city that takes its place, plain English name.' },
        explanation: { type: 'string', description: 'One-sentence explanation for the user.' },
      },
      required: ['old', 'new', 'explanation'],
    },
  },
];

/** The system prompt for one turn. Today's date is computed per call. */
export function chatSystemPrompt(currentTrip: any): string {
  const context = tripContextForChat(currentTrip);
  return `You are BlueMurr AI, a travel-planning assistant embedded in the user's itinerary page. You help travelers refine their trip in plain English.

Today is ${todayIso()} (UTC). Trip dates are always in the future: a date the user gives without a year ("Dec 10", "the 15th") means its next occurrence after today.

THE TRIP'S LEGS: TRIP CONTEXT "legs" lists every leg in travel order, INCLUDING the flight from home to the first city and the flight from the last city back home. Each leg has an id, its current option and the other options on its card (cardOptions, each with an optionId). Always name a leg by its id.
- "my flight home", "the flight back", "the return", "back to <home city>" = the leg whose id ends in "→home".
- "my flight out", "the flight there", "out of <home city>" = the leg whose id starts with "home→".

Tools:
1. answer_only — plain questions, explanations, small talk.
2. ask_which_leg — the user wants to change or see a flight/train without saying which leg, and there is more than one leg. Do NOT guess a leg.
3. select_transport_option — switch a leg to one specific option already in its cardOptions ("the British Airways one", "the 19:25", "the cheapest one").
4. find_transport_option — a different option described by what it should be: later / earlier, a time of day, a time bound, cheaper, a mode, an airline. Proposes the cheapest match. Use list=true when the user asked to see options ("show me evening flights home").
5. set_transport_window — a time rule on a leg ("no flights before 5pm").
6. show_transport_options — refresh a leg's card with its cheapest options ("are there more flights?").
7. compare_modes — flight vs train on a leg between two trip cities.
8. pin_city_dates — lock a city to specific dates.
9. set_min_days — a minimum stay in a city.
10. add_city / remove_city / replace_city — add, drop or swap a city. Each change is shown to the user as a diff to Accept, so call the tool directly instead of asking "are you sure?".

ALWAYS pick exactly one tool per turn.

Changing transport: if the option the user names is in that leg's cardOptions, use select_transport_option; otherwise find_transport_option. Pass what they asked ("later in the evening" → relative "later" AND timeOfDay "evening"; "cheaper" → cheaper true). The server searches, checks and words the result — don't promise prices or times yourself.

If there is only ONE leg, use it. If the user names a city pair that isn't a leg, call the tool with what they said; the server lists the real legs.

City edits: ONE city edit per turn. If the user asks for several at once, do the first and say you'll do the next after they accept. If it's unclear which city they mean (e.g. "swap one of the Italian cities", "add a beach town", a country instead of a city), use answer_only to ask. Use the exact trip spelling for cities already in the trip.

If the user references a city that isn't in the trip for a pin or a min stay, answer_only and ask them to clarify — do NOT invent a pin.

Be concise. Reference concrete numbers (prices, durations, dates) from the trip when you have them. Prices are totals for all travellers.

TRIP CONTEXT (read-only):
${JSON.stringify(context, null, 2)}
`;
}

/**
 * Run one chat turn. See the seam comment at the top of this file for the
 * input and output contract.
 */
export async function runTripChat(input: TripChatInput): Promise<TripChatResult> {
  const { message, currentTrip, history } = input;
  const anthropic = getAnthropicSafe();
  if (!anthropic) {
    return {
      type: 'answer',
      reply:
        "I'm offline right now — the Anthropic API key isn't configured on the server. Ask your admin to set ANTHROPIC_API_KEY.",
    };
  }

  // Prior history, then the new user message. The trip goes in the system
  // prompt so Claude sees it as persistent context rather than a turn.
  const messages: ChatTurn[] = [];
  for (const turn of history ?? []) messages.push({ role: turn.role, content: turn.content });
  messages.push({ role: 'user', content: message });

  let response: any;
  try {
    response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: chatSystemPrompt(currentTrip),
      tools: CHAT_TOOLS as any,
      messages,
    });
  } catch (err: any) {
    logger.warn('plan/chat Claude call failed', { message: err?.message });
    return {
      type: 'answer',
      reply: 'Sorry — I hit an error reaching the AI. Please try again in a moment. If it keeps happening, let us know.',
    };
  }

  const toolUse = response.content.find((b: any) => b.type === 'tool_use') as any;
  if (!toolUse) {
    // Claude answered in text instead of calling a tool.
    const textBlock = response.content.find((b: any) => b.type === 'text') as any;
    return { type: 'answer', reply: textBlock?.text ?? "I'm not sure how to help with that — could you rephrase?" };
  }
  try {
    return await runTool(currentTrip, toolUse.name as string, (toolUse.input ?? {}) as any);
  } catch (err: any) {
    logger.error('plan/chat tool failed', { tool: toolUse.name, message: err?.message });
    return { type: 'answer', reply: "Sorry — something went wrong working that out, so I didn't change anything. Please try again." };
  }
}

/** Dispatch one tool call. Exported for tests of a tool without a model. */
export async function runTool(currentTrip: any, toolName: string, toolInput: any): Promise<TripChatResult> {
  if (toolName === 'answer_only') return { type: 'answer', reply: toolInput.answer };

  const legs = tripLegs(currentTrip);

  if (toolName === 'ask_which_leg') return { type: 'answer', reply: whichLegReply(legs) };

  if (toolName === 'select_transport_option') return selectOption(currentTrip, legs, toolInput);
  if (toolName === 'find_transport_option') return findOption(currentTrip, legs, toolInput, toolName);

  // --- City edits: add_city / remove_city / replace_city. Priced (new
  //     city's hotels, the legs that changed, home flights when the trip's
  //     ends changed) and returned as a proposal. Nothing is applied until Accept.
  if (toolName === 'add_city' || toolName === 'remove_city' || toolName === 'replace_city') {
    const op = cityEditOpFromTool(toolName, toolInput);
    if (!op) return { type: 'answer', reply: "Which city did you mean? Tell me the name and I'll work it out." };
    const built = await buildCityEditProposal(currentTrip, toolName, op);
    if (built.type === 'answer') return built;
    // Worded from the plan, not the model's `explanation`, which is written
    // before anything was searched (see compare_modes, D-07).
    return {
      type: 'proposal',
      reply: `${describeCityEdit(built.proposal)} ${built.proposal.note} Accept to apply it.`,
      proposal: built.proposal,
    };
  }

  if (toolName === 'compare_modes') return compareModes(currentTrip, legs, toolInput);
  if (toolName === 'set_transport_window' || toolName === 'show_transport_options') {
    return refreshLeg(currentTrip, legs, toolName, toolInput);
  }
  if (toolName === 'pin_city_dates' || toolName === 'set_min_days') return dateTool(currentTrip, toolName, toolInput);

  logger.warn('plan/chat unknown tool', { toolName });
  return { type: 'answer', reply: "I'm not sure how to help with that — could you rephrase?" };
}

/** A leg lookup that isn't a leg, as the reply to send instead. */
function lookupReply(lookup: Exclude<LegLookup, { kind: 'leg' }>, legs: TripLeg[], noun = 'flight or train'): string {
  if (lookup.kind === 'missing') return whichLegReply(legs);
  if (lookup.kind === 'not_a_leg') return notALegReply(legs, lookup);
  return `I couldn't find a ${lookup.from} → ${lookup.to} ${noun} in your trip — its legs are ${listLegs(legs)}.`;
}

/** The leg a leg-tool names; with no leg named, the only leg if there is just one. */
function legFor(currentTrip: any, legs: TripLeg[], input: any): LegLookup {
  const lookup = resolveLeg(currentTrip, legs, { leg: input?.leg, from: input?.from, to: input?.to });
  if (lookup.kind === 'missing' && legs.length === 1) return { kind: 'leg', leg: legs[0] };
  return lookup;
}

/** Propose `after`, or say why not. The reply is written from the checked proposal. */
function propose(
  currentTrip: any,
  leg: TripLeg,
  after: LegChoice,
  request: ChoiceRequest,
  toolName: string,
  lead: string,
): TripChatResult {
  const proposal = buildTransportProposal(currentTrip, leg, after, request, toolName);
  const problems = verifyTransportProposal(proposal, leg);
  if (problems.length > 0) {
    logger.error('plan/chat transport proposal failed verification', { leg: leg.id, problems, after });
    return {
      type: 'answer',
      reply: `I couldn't set that up for ${legLabel(leg)} — the option I found didn't check out (${problems[0]}), so nothing changed.`,
    };
  }
  return { type: 'proposal', reply: describeTransportProposal(proposal, leg, lead), proposal };
}

/** select_transport_option: exactly the card option the user named. */
function selectOption(currentTrip: any, legs: TripLeg[], input: any): TripChatResult {
  const optionId = typeof input?.optionId === 'string' ? input.optionId.trim() : '';
  // The option id carries its leg; use it when the leg wasn't given.
  const ref = input?.leg ?? (optionId ? optionId.replace(/[#~]\d+$/, '') : undefined);
  const lookup = legFor(currentTrip, legs, { leg: ref });
  if (lookup.kind !== 'leg') return { type: 'answer', reply: lookupReply(lookup, legs) };
  const leg = lookup.leg;
  const n = /(?:^|[#~])(\d+)$/.exec(optionId)?.[1];
  const option = leg.options.find((o) => o.optionId === optionId) ?? (n != null ? leg.options.find((o) => o.optionId === `${leg.id}#${n}`) : undefined);
  if (!option) {
    const listed = leg.options.filter((o) => o !== leg.current);
    return {
      type: 'answer',
      reply: listed.length
        ? `I couldn't find that option on the ${legLabel(leg)} card. It shows: ${listed.map((o) => `${describeChoice(o)} ${money(o.price)}`).join('; ')}. Which one?`
        : `The ${legLabel(leg)} card has no other options yet — want me to search for some?`,
    };
  }
  if (leg.current && option.optionId === leg.current.optionId) {
    return { type: 'answer', reply: `${describeChoice(option)} is already ${legPhrase(leg)}, so there's nothing to change.` };
  }
  return propose(currentTrip, leg, option, { optionId: option.optionId }, 'select_transport_option', `Switch ${legPhrase(leg)} to`);
}

const LIST_LIMIT = 5;

/**
 * find_transport_option (and set_transport_window / show_transport_options on
 * a home leg): search the leg, keep what satisfies the request, then propose
 * the cheapest match — or list the matches when `list` is set. No match: say
 * so and change nothing.
 */
async function findOption(currentTrip: any, legs: TripLeg[], input: any, toolName: string, forceList = false): Promise<TripChatResult> {
  const lookup = legFor(currentTrip, legs, input);
  if (lookup.kind !== 'leg') return { type: 'answer', reply: lookupReply(lookup, legs) };
  const leg = lookup.leg;

  const read = readRequest(input);
  if (!read.ok) return { type: 'answer', reply: `${read.reply} Nothing changed.` };
  const request = read.request;
  const problem = requestProblem(request, leg);
  if (problem) return { type: 'answer', reply: `${problem}. Nothing changed.` };

  const searched = await searchLeg(currentTrip, leg);
  if (!searched.ok) return { type: 'answer', reply: `${searched.reply} Nothing changed.` };
  const what = describeRequest(request, leg);
  const when = shortDate(leg.date);
  if (searched.choices.length === 0) {
    return { type: 'answer', reply: `I couldn't find any options for ${legLabel(leg)} on ${when}, so nothing changed.` };
  }
  const matches = matchingChoices(searched.choices, request, leg);
  if (matches.length === 0) {
    const others = searched.choices.filter((c) => !(leg.current && c === leg.current));
    const why = unmetSummary(others, request, leg);
    return {
      type: 'answer',
      reply: `I searched ${searched.choices.length} option${searched.choices.length === 1 ? '' : 's'} for ${legLabel(leg)} on ${when} and none is a ${what}${why}. Nothing changed — want me to try a different time or day?`,
    };
  }

  if (input?.list === true || forceList) {
    const shown = matches.slice(0, LIST_LIMIT);
    const lines = shown.map((c, i) => {
      const delta = leg.current ? ` (${signedMoney(c.price - leg.current.price)})` : '';
      return `${i + 1}. ${describeChoice(c)} — ${money(c.price)}${delta}`;
    });
    const more = matches.length > shown.length ? ` (${matches.length} found, cheapest ${shown.length} shown)` : '';
    const onCard = leg.current
      ? `They're on the ${legLabel(leg)} card now — pick one there, or tell me which and I'll set it up for you to accept. Nothing has changed yet.`
      : 'Tell me which one you want and I\'ll set it up for you to accept.';
    return {
      type: 'leg_options',
      reply: `${capitalize(what)} options for ${legLabel(leg)} on ${when}${more}:\n${lines.join('\n')}\n${onCard}`,
      legOptions: {
        leg: { id: leg.id, kind: leg.kind, index: leg.index, from: leg.from, to: leg.to, date: leg.date },
        options: shown,
        totalFound: matches.length,
      },
    };
  }

  // "A cheaper flight home (London → New York):" / "The cheapest later
  // evening flight home (London → New York) I found:".
  const label = legLabel(leg);
  const subject =
    leg.kind === 'return' ? `${what} home (${label})` : leg.kind === 'outbound' ? `${what} out (${label})` : `${what} for ${label}`;
  const lead = request.cheaper ? `A ${subject}:` : `The cheapest ${subject} I found:`;
  return propose(currentTrip, leg, matches[0], request, toolName, lead);
}

/** " — the latest leaves at 12:23" style hint for a no-match reply. */
function unmetSummary(choices: LegChoice[], request: ChoiceRequest, leg: TripLeg): string {
  const times = choices.map((c) => c.departTime).filter((t): t is string => !!t).sort();
  if ((request.relative === 'later' || request.window?.earliestDepart) && times.length) {
    return ` (the latest leaves at ${times[times.length - 1]})`;
  }
  if ((request.relative === 'earlier' || request.window?.latestDepart) && times.length) {
    return ` (the earliest leaves at ${times[0]})`;
  }
  if (request.cheaper && leg.current) {
    const cheapest = choices.map((c) => c.price).filter((p) => p > 0).sort((a, b) => a - b)[0];
    if (cheapest != null) return ` (the cheapest is ${money(cheapest)}, you have ${money(leg.current.price)})`;
  }
  return '';
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ─── compare_modes ────────────────────────────────────────────────

async function compareModes(currentTrip: any, legs: TripLeg[], toolInput: any): Promise<TripChatResult> {
  const lookup = legFor(currentTrip, legs, toolInput);
  if (lookup.kind === 'unknown_city') {
    return { type: 'answer', reply: `I couldn\'t find a ${lookup.from} → ${lookup.to} leg in your trip.` };
  }
  // A comparison for a non-leg would be priced on the wrong day (the
  // from-city's departure to a DIFFERENT next city), and its "Switch" button
  // asks for that non-leg as a refresh next.
  if (lookup.kind !== 'leg') return { type: 'answer', reply: lookupReply(lookup, legs) };
  const leg = lookup.leg;
  if (leg.kind !== 'intercity') {
    return {
      type: 'answer',
      reply: `I can only search flights to and from home, so there's no train to compare for ${legLabel(leg)}. Want me to look for a different flight instead?`,
    };
  }
  const fromCity = currentTrip.cities[leg.index];
  const toCity = currentTrip.cities[leg.index + 1];

  const travelDate = leg.date;
  if (!travelDate) {
    return { type: 'answer', reply: `I need a departure date for ${fromCity.name} before I can compare options.` };
  }

  const cmp = await compareLeg({
    origin: fromCity.name,
    destination: toCity.name,
    date: travelDate,
    travelers: currentTrip.travelers ?? 1,
    originCountry: fromCity.country ?? getCityCountry(fromCity.name),
    destinationCountry: toCity.country ?? getCityCountry(toCity.name),
  }).catch(() => null);

  if (!cmp || (!cmp.flightOption && !cmp.trainOption)) {
    return {
      type: 'answer',
      reply: `I couldn\'t find any flight or train options for ${fromCity.name} → ${toCity.name} on ${travelDate}.`,
    };
  }

  const fmtDuration = (mins: number) => {
    if (!mins || !Number.isFinite(mins)) return '—';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  const flightSummary = cmp.flightOption
    ? {
        mode: 'flight' as const,
        operator: cmp.flightOption.carrier,
        price: cmp.flightOption.price,
        currency: cmp.flightOption.currency,
        duration: fmtDuration(cmp.flightOption.durationMinutes),
        durationMinutes: cmp.flightOption.durationMinutes,
        stops: cmp.flightOption.stops,
        bookingUrl: cmp.flightOption.bookingUrl ?? null,
      }
    : null;

  const trainSummary = cmp.trainOption
    ? {
        mode: 'train' as const,
        operator: cmp.trainOption.operator,
        price: cmp.trainOption.price ?? 0,
        currency: cmp.trainOption.currency ?? 'USD',
        duration: fmtDuration(cmp.trainOption.durationMinutes),
        durationMinutes: cmp.trainOption.durationMinutes,
        bookingUrl: cmp.trainOption.bookingUrl ?? null,
      }
    : null;

  // The reply is built from what the search found, not the model's
  // `explanation` (D-07).
  return {
    type: 'mode_comparison',
    reply: describeComparison(fromCity.name, toCity.name, travelDate, flightSummary, trainSummary, cmp),
    comparison: {
      fromCity: fromCity.name,
      toCity: toCity.name,
      date: travelDate,
      flight: flightSummary,
      train: trainSummary,
      cheapest: cmp.cheapest,
      fastest: cmp.fastest,
      recommendation: cmp.recommendation,
      priceDifference: cmp.priceDifference,
      timeDifference: cmp.timeDifference,
    },
  };
}

// ─── set_transport_window / show_transport_options ────────────────

/**
 * Leg-refresh tools. On an inter-city leg both re-search it and return a
 * leg_refresh the frontend writes onto the card (unchanged behaviour). On a
 * home leg — stored on trip.origin, not on a city pair — a window becomes a
 * proposal for the cheapest flight inside it, and a refresh lists the
 * cheapest flights on the card without changing the selection.
 *
 * set_transport_window also returns the window in updatedConstraints, which
 * the frontend keeps on the in-memory trip. That is a record, not a rule: no
 * save path writes it and no re-optimization reads it.
 */
async function refreshLeg(currentTrip: any, legs: TripLeg[], toolName: string, toolInput: any): Promise<TripChatResult> {
  const lookup = legFor(currentTrip, legs, toolInput);
  if (lookup.kind === 'unknown_city') {
    return { type: 'answer', reply: `I couldn\'t find a ${lookup.from} → ${lookup.to} flight or train in your trip.` };
  }
  // Both cities exist but aren't consecutive: there is no such leg to
  // refresh. The frontend applies a refresh by city NAME — it sets the
  // from-city's transportOut and the to-city's transportIn — so on Rome →
  // Venice → Florence a "Rome → Florence" refresh overwrote Rome's real
  // Rome → Venice leg (B9). Answer instead, naming the legs that do exist.
  if (lookup.kind !== 'leg') return { type: 'answer', reply: lookupReply(lookup, legs) };
  const leg = lookup.leg;

  if (leg.kind !== 'intercity') {
    if (toolName === 'show_transport_options') return findOption(currentTrip, legs, { leg: leg.id }, toolName, true);
    return findOption(currentTrip, legs, { ...toolInput, leg: leg.id, list: false }, toolName);
  }

  const fromCity = currentTrip.cities[leg.index];
  const toCity = currentTrip.cities[leg.index + 1];
  const travelDate = fromCity.dates?.departure ?? fromCity.departure_date ?? null;
  if (!travelDate) {
    return { type: 'answer', reply: `I need a departure date for ${fromCity.name} before I can find matching options.` };
  }

  const currentTransport = fromCity.transportOut ?? null;
  const currentPrice = currentTransport?.price ?? 0;
  const existingConstraints: TripConstraints = currentTrip.constraints ?? {};

  // Bounds are normalised to HH:MM here ("5pm" → "17:00") so the filter,
  // the reply and the stored constraint all use the same value. A bound we
  // can't read is answered as such BEFORE searching (B10).
  let window: NormalizedTimeWindow | undefined;
  if (toolName === 'set_transport_window') {
    const normalized = normalizeTimeWindow({
      earliestDepart: toolInput.earliestDepart,
      latestDepart: toolInput.latestDepart,
      earliestArrive: toolInput.earliestArrive,
      latestArrive: toolInput.latestArrive,
    });
    if (!normalized.ok) {
      return {
        type: 'answer',
        reply: `I couldn\'t set a time window on ${fromCity.name} → ${toCity.name}: ${JSON.stringify(normalized.raw)} isn\'t a clock time I can use for the ${WINDOW_BOUND_LABEL[normalized.bound]}. Give me one like 17:00 or 5pm.`,
      };
    }
    window = normalized.window;
  }

  const legSearch = await searchLegOptions({
    from: fromCity.name,
    to: toCity.name,
    date: travelDate,
    travelers: currentTrip.travelers ?? 1,
    fromCountry: fromCity.country ?? getCityCountry(fromCity.name),
    toCountry: toCity.country ?? getCityCountry(toCity.name),
    window,
    currentPrice,
    limit: 4,
  });

  // Count every match (pre-limit) so the summary can say "found 12,
  // showing top 4" — only when a window is present.
  let totalFound = legSearch.options.length;
  if (window) {
    const unlimited = await searchLegOptions({
      from: fromCity.name,
      to: toCity.name,
      date: travelDate,
      travelers: currentTrip.travelers ?? 1,
      fromCountry: fromCity.country ?? getCityCountry(fromCity.name),
      toCountry: toCity.country ?? getCityCountry(toCity.name),
      window,
      currentPrice,
      limit: 100,
    }).catch(() => null);
    if (unlimited) totalFound = unlimited.options.length;
  }

  if (!legSearch.hasMatches) {
    const bounds = window ? describeWindow(window) : '';
    const conflict =
      window && legSearch.windowFilteredAll
        ? `No flights or trains from ${fromCity.name} to ${toCity.name} match ${bounds}. Want me to relax the window, or pick a different departure date?`
        : `I couldn\'t find any flights or trains from ${fromCity.name} to ${toCity.name} on ${travelDate}. Try another date.`;
    return { type: 'answer', reply: conflict };
  }

  const shownCount = legSearch.options.length;
  const cheapest = legSearch.options[0];

  // The frontend makes options[0] the leg's selection, so a refresh whose
  // fresh cheapest costs MORE than the current option raised the trip on a
  // "cheaper" request (D-03). show_transport_options keeps the current
  // option first; set_transport_window is exempt (the current option may
  // break the window).
  const keepCurrent =
    toolName === 'show_transport_options' && currentTransport != null && currentPrice > 0 && cheapest.price >= currentPrice;
  let options = legSearch.options;
  if (keepCurrent) {
    const kept = transportToLegOption(currentTransport, cheapest.currency);
    options = [kept, ...options.filter((o) => !isSameLegOption(o, kept))].slice(0, 4);
  }

  const summaryBits: string[] = [];
  const foundCountPhrase =
    totalFound > shownCount
      ? `Found ${totalFound}, showing the top ${shownCount}`
      : `Found ${shownCount} option${shownCount === 1 ? '' : 's'}`;
  summaryBits.push(`${foundCountPhrase} for ${fromCity.name} → ${toCity.name}`);
  if (window) {
    const windowPhrase = describeWindow(window);
    if (windowPhrase) summaryBits.push(windowPhrase);
  }
  const delta = cheapest.priceDelta;
  if (keepCurrent) {
    const nextBest = delta >= 0.5 ? `next best is +$${delta.toFixed(0)}` : 'next best costs the same';
    summaryBits.push(`nothing cheaper than your current $${currentPrice.toFixed(0)}, so I kept it (${nextBest})`);
  } else if (currentPrice > 0 && delta < 0) {
    summaryBits.push(`cheapest saves $${Math.abs(delta).toFixed(0)}`);
  } else if (currentPrice > 0 && delta > 0) {
    summaryBits.push(`cheapest is +$${delta.toFixed(0)}`);
  }
  const summary = summaryBits.join(' — ') + '. Pick one on the transport card to use it.';

  let updatedConstraints = existingConstraints;
  if (toolName === 'set_transport_window' && window) {
    updatedConstraints = mergeConstraints(existingConstraints, {
      transport_windows: [
        {
          from: fromCity.name,
          to: toCity.name,
          earliestDepart: window.earliestDepart,
          latestDepart: window.latestDepart,
          earliestArrive: window.earliestArrive,
          latestArrive: window.latestArrive,
        },
      ],
    });
  }

  return {
    type: 'leg_refresh',
    reply: summary,
    refresh: { fromCity: fromCity.name, toCity: toCity.name, date: travelDate, options, totalFound, updatedConstraints },
  };
}

// ─── pin_city_dates / set_min_days ────────────────────────────────

/**
 * Date-bearing tools: compute a new set of city dates + a visual diff.
 *
 * The proposal's reply is the model's own `explanation`, written before
 * anything was checked — so a constraint we can't apply must NOT become a
 * proposal (B10). Each failed check answers instead: "I couldn't <attempt>:
 * <reason>."
 */
function dateTool(currentTrip: any, toolName: string, toolInput: any): TripChatResult {
  const existingConstraints: TripConstraints = currentTrip.constraints ?? {};
  let constraintUpdate: TripConstraints = {};
  const replyText = toolInput.explanation ?? 'I have a proposed change for you.';
  let attempt = '';
  let target: any = null;
  let minNights: number | null = null;
  const couldnt = (reason: string): TripChatResult => ({ type: 'answer', reply: `I couldn\'t ${attempt}: ${reason}.` });

  if (toolName === 'pin_city_dates') {
    const match = (currentTrip.cities ?? []).find((c: any) => c.name.toLowerCase() === String(toolInput.city).toLowerCase());
    if (!match) {
      return {
        type: 'answer',
        reply: `I couldn\'t find "${toolInput.city}" in your trip. Did you mean one of: ${(currentTrip.cities ?? [])
          .map((c: any) => c.name)
          .join(', ')}?`,
      };
    }
    attempt =
      isIsoDate(toolInput.arrival) && isIsoDate(toolInput.departure)
        ? `pin ${match.name} to ${toolInput.arrival} – ${toolInput.departure}`
        : `pin ${match.name}`;
    const problem = pinProblem(toolInput.arrival, toolInput.departure);
    if (problem) return couldnt(problem);
    target = match;
    constraintUpdate = { pinned_cities: [{ city: match.name, arrival: toolInput.arrival, departure: toolInput.departure }] };
  } else {
    const match = (currentTrip.cities ?? []).find((c: any) => c.name.toLowerCase() === String(toolInput.city).toLowerCase());
    if (!match) return { type: 'answer', reply: `I couldn\'t find "${toolInput.city}" in your trip.` };
    minNights = parseMinNights(toolInput.minNights);
    if (minNights == null) {
      attempt = `set a minimum stay for ${match.name}`;
      return couldnt(
        `it has to be a whole number of nights from 1 to ${MAX_STAY_NIGHTS}, and I got ${JSON.stringify(toolInput.minNights ?? null)}`,
      );
    }
    attempt = `give ${match.name} at least ${minNights} night${minNights === 1 ? '' : 's'}`;
    target = match;
    constraintUpdate = { min_days: [{ city: match.name, minNights }] };
  }

  const proposedConstraints = mergeConstraints(existingConstraints, constraintUpdate);
  const dbShapeCities = (currentTrip.cities ?? []).map((c: any) => ({
    name: c.name,
    arrival_date: c.dates?.arrival ?? c.arrival_date ?? null,
    departure_date: c.dates?.departure ?? c.departure_date ?? null,
  }));
  const { cities: newCities, diff } = applyDateConstraints(dbShapeCities, proposedConstraints);

  if (target) {
    // Valid on its own can still be impossible in context: a pin that pushes
    // earlier cities into the past, or two pins with too little room.
    const schedule = scheduleProblem(dbShapeCities, newCities);
    if (schedule) return couldnt(schedule);
    if (minNights != null) {
      const shortfall = minDaysProblem(newCities[(currentTrip.cities ?? []).indexOf(target)], minNights, proposedConstraints);
      if (shortfall) return couldnt(shortfall);
    }
  }

  const proposedTrip = {
    ...currentTrip,
    constraints: proposedConstraints,
    cities: (currentTrip.cities ?? []).map((c: any, i: number) => ({
      ...c,
      dates: { arrival: newCities[i].arrival_date, departure: newCities[i].departure_date },
    })),
  };

  return {
    type: 'proposal',
    reply: replyText,
    proposal: { kind: 'date_shift', toolName, toolInput, diff, proposedConstraints, proposedTrip },
  };
}

// ─── Helpers (moved unchanged from routes/plan.ts) ────────────────

/**
 * The leg's current transport (frontend Transport shape) as a LegOption, so
 * a refresh can list it first and the frontend's legOptionToTransport
 * rebuilds the same selection. priceDelta is 0 by definition.
 */
function transportToLegOption(t: any, currency: string): LegOption {
  return {
    mode: t.mode,
    operator: t.operator ?? '',
    flightNumber: (t.mode === 'train' ? t.trainNumber : t.flightNumber) ?? null,
    price: t.price,
    currency,
    departTime: t.departTime ?? null,
    arriveTime: t.arriveTime ?? null,
    duration: t.duration ?? '',
    durationMinutes: parseDurationMinutes(t.duration),
    stops: t.layovers ?? 0,
    bookingUrl: t.bookingUrl ?? null,
    priceDelta: 0,
  };
}

/** Same departure at the same price — a fresh search re-finding the current option. */
function isSameLegOption(a: LegOption, b: LegOption): boolean {
  return a.mode === b.mode && a.operator === b.operator && a.departTime === b.departTime && Math.abs(a.price - b.price) < 0.01;
}

/** "Here's your trip with Venice added after Rome." — from the planned edit. */
function describeCityEdit(p: CityEditProposal): string {
  const op = p.op;
  if (op.kind === 'replace') {
    const added = p.after.find((s) => s.status === 'replaced');
    return `Here's your trip with ${added?.name ?? op.newCity} instead of ${added?.replaces ?? op.oldCity}.`;
  }
  if (op.kind === 'remove') return `Here's your trip without ${p.removed[0] ?? op.city}.`;
  const idx = p.after.findIndex((s) => s.status === 'added');
  const prev = idx > 0 ? p.after[idx - 1].name : null;
  return `Here's your trip with ${op.city} added${idx === p.after.length - 1 ? ' at the end' : prev ? ` after ${prev}` : ''}.`;
}

/**
 * The compare_modes reply, stated from the same numbers the card shows. A
 * missing mode is said plainly, a train with no price is "at an unknown
 * price", and cheaper/faster is only claimed when both sides have the number.
 */
function describeComparison(
  from: string,
  to: string,
  date: string,
  flight: { price: number; duration: string; durationMinutes: number } | null,
  train: { price: number; duration: string; durationMinutes: number } | null,
  cmp: { cheapest: string; fastest: string },
): string {
  const leg = `${from} → ${to}`;
  const price = (p: number) => (p > 0 ? `from $${Math.round(p)}` : 'at an unknown price');
  if (flight && !train) return `I found no train for ${leg} on ${date} — only flights, ${price(flight.price)} (${flight.duration}).`;
  if (train && !flight) return `I found no flight for ${leg} on ${date} — only trains, ${price(train.price)} (${train.duration}).`;
  if (!flight || !train) return `I couldn\'t find any flight or train options for ${leg} on ${date}.`;

  const found = `${leg} on ${date}: flight ${price(flight.price)} (${flight.duration}), train ${price(train.price)} (${train.duration}).`;
  const isMode = (m: string) => m === 'flight' || m === 'train';
  const cheaper = flight.price > 0 && train.price > 0 && isMode(cmp.cheapest) ? cmp.cheapest : null;
  const faster = flight.durationMinutes > 0 && train.durationMinutes > 0 && isMode(cmp.fastest) ? cmp.fastest : null;
  if (cheaper && cheaper === faster) return `${found} The ${cheaper} is both cheaper and faster.`;
  if (cheaper && faster) return `${found} The ${cheaper} is cheaper; the ${faster} is faster.`;
  if (cheaper) return `${found} The ${cheaper} is cheaper.`;
  if (faster) return `${found} The ${faster} is faster.`;
  return found;
}

/** How a window bound reads in a reply. */
const WINDOW_BOUND_LABEL = {
  earliestDepart: 'earliest departure',
  latestDepart: 'latest departure',
  earliestArrive: 'earliest arrival',
  latestArrive: 'latest arrival',
} as const;

/** "arriving before 14:00", "departing between 17:00 and 22:00"; '' with no bounds. */
function describeWindow(w: {
  earliestDepart?: string | null;
  latestDepart?: string | null;
  earliestArrive?: string | null;
  latestArrive?: string | null;
}): string {
  const bits: string[] = [];
  if (w.earliestDepart && w.latestDepart) bits.push(`departing between ${w.earliestDepart} and ${w.latestDepart}`);
  else if (w.earliestDepart) bits.push(`departing after ${w.earliestDepart}`);
  else if (w.latestDepart) bits.push(`departing before ${w.latestDepart}`);

  if (w.earliestArrive && w.latestArrive) bits.push(`arriving between ${w.earliestArrive} and ${w.latestArrive}`);
  else if (w.earliestArrive) bits.push(`arriving after ${w.earliestArrive}`);
  else if (w.latestArrive) bits.push(`arriving before ${w.latestArrive}`);

  return bits.join(', ');
}
