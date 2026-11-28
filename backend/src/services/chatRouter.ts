/**
 * BlueMurr AI chat — model routing. Sends each question to the cheapest tier
 * that answers it correctly, and escalates whenever it isn't sure:
 *
 *   tier 0  no AI     a plain lookup answered from the trip with a template
 *                     ("what time is our flight home?", "which hotel in Paris?")
 *   tier 1  TIER1_MODEL (Haiku)  wording only, NO trip-changing tools: it may
 *                     answer from the trip or escalate, and its answer is checked
 *                     (guard) before it is used
 *   tier 2  TIER2_MODEL  today's path — every chat tool, proposals, searches
 *
 * One switch, env CHAT_ROUTING (read per call):
 *   off (default)  today's behaviour exactly: every question to tier 2
 *   shadow         answer on tier 2 as today, and log the tier the router
 *                  WOULD have picked and whether it agreed with tier 2
 *   on             route
 *
 * Tiers 0 and 1 only ever return { type: 'answer', reply }. Proposals, searches
 * and options come only from tier 2's runTool.
 *
 * Design: PLAN.md, written up and checked against the code before building
 * (2026-11-28). Cost figures: aiUsage.ts MODEL_PRICES.
 */
import { logger } from '../utils/logger';
import { addDays } from '../utils/dates';
import { DEFAULT_MODEL } from './anthropic';
import { createMessage } from './aiUsage';
import { describeChoice, legPhrase, perPersonWord, shortDate, tripLegs, type LegChoice, type TripLeg } from './tripLegs';
import { getCityCountry } from '../data/cityCountries';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** Tier-1 model. Putting it on a user-facing path (CHAT_ROUTING=on) needs the owner's OK. */
export const TIER1_MODEL = 'claude-haiku-5-5';
/** Tier-2 model: today's model until the owner approves a change. */
export const TIER2_MODEL = DEFAULT_MODEL;

export type RoutingMode = 'off' | 'shadow' | 'on';
export function chatRoutingMode(): RoutingMode {
  const v = String(process.env.CHAT_ROUTING ?? '').trim().toLowerCase();
  return v === 'on' || v === 'shadow' ? v : 'off';
}

// ─── Text helpers ────────────────────────────────────────────────────

/** Lower-case, no accents, one space, no trailing punctuation. */
export function fold(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
const stripEnd = (s: string) => s.replace(/[?.!\s]+$/, '');

// ─── History ─────────────────────────────────────────────────────────

/**
 * A turn that offered a change or asked the user to pick: what follows it
 * ("yes", "the second one") belongs to tier 2. The chat panel rewrites a
 * proposal turn before sending it as history (AIChatPanel.tsx: "[The user has
 * not accepted this change yet; …]" / accepted / rejected), so both the
 * server's own wording and the panel's brackets count.
 */
export const PROPOSAL_MARKERS: RegExp[] = [
  /\[The user [^\]]*this change/i,
  /Accept to apply it/i,
  /Accept to switch/i,
  /Accept to add/i,
  /^Which one —/,
  /Did you mean\b/i,
  /Which one did you mean\?/i,
  /Which city did you mean\?/i,
];
export const isProposalTurn = (content: string) => PROPOSAL_MARKERS.some((re) => re.test(content ?? ''));

/** The panel's opening greeting, sent as an assistant turn every time. Not a real conversation. */
const isGreeting = (t: ChatTurn) => t.role === 'assistant' && /Ask me anything —/.test(t.content ?? '');
export const realHistory = (history: ChatTurn[] = []) => history.filter((t) => !isGreeting(t));

// ─── Pre-filter: straight to tier 2 ──────────────────────────────────

const WORDS = (list: string) => new RegExp(`\\b(?:${list})\\b`, 'i');
const PREFILTER: Array<[string, RegExp]> = [
  ['change', WORDS('change|changing|switch|swap|move|add|remove|drop|replace|cancel|book|booking|reserve|reservation|instead|extend|shorten|reorder|skip|rearrange|upgrade|downgrade')],
  ['prefer', WORDS("rather|prefer|want|wanna|would like|i'd like|we'd like|let's|lets|can (?:we|i|you)|could (?:we|i|you)|should (?:we|i)|make|give|set|push|shift|delay|bump|postpone|longer|shorter|more|fewer|less|extra|another|later|earlier")],
  ['search', WORDS('options?|alternatives?|direct|nonstop|non-stop|other flights?|other trains?|search|find|show me|any (?:other|better)')],
  ['price', /\$|\b(?:how much|cost|costs|price|prices|pricing|fare|fares|pay|paying|spend|total|budget|expensive|cheap|cheaper|cheapest|save|saving|savings|deal)\b/i],
  ['compare', WORDS('compare|comparison|vs|versus|better|best|faster|fastest|quicker')],
  ['why', WORDS('why|how come|reason')],
  ['weather', WORDS('weather|rain|raining|rainy|forecast|temperature|cold|warm|hot|snow|sunny|coat|jacket|umbrella|wear|pack|packing|bring')],
  ['dining', WORDS('dinner|lunch|breakfast|restaurant|restaurants|eat|eating|food|reservation')],
  ['plans', WORDS('activities|activity|things to do|see|visit|museum|tour|sights?|recommend|suggest|ideas?')],
];

export type Prefilter = { rule: string } | null;

/** Rules that send a message straight to tier 2, or null. */
export function prefilter(message: string, history: ChatTurn[] = []): Prefilter {
  const m = fold(message);
  const real = realHistory(history);
  const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
  if (lastAssistant && isProposalTurn(lastAssistant.content)) return { rule: 'after_proposal' };
  if (/\b(?:yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|please do|sounds good|no|nope|nah|that|this|it|those|them|these|same|the (?:first|second|third|last|other) ?(?:one)?|that one)\b/i.test(m)) {
    return { rule: 'back_reference' };
  }
  if (real.length > 0 && m.split(' ').filter(Boolean).length < 4) return { rule: 'short_followup' };
  if (real.length > 0 && /\bthe (?:flight|train)\b/.test(m) && !/\b(?:home|back|out|there)\b/.test(m)) return { rule: 'unnamed_leg' };
  for (const [rule, re] of PREFILTER) if (re.test(m)) return { rule };
  return null;
}

// ─── Tier 0: templates ───────────────────────────────────────────────

export type Tier0 = { intent: string; reply: string };

const fmtRange = (a: string, b: string) => {
  const x = shortDate(a);
  const y = shortDate(b);
  return x.slice(0, 3) === y.slice(0, 3) ? `${x}–${y.slice(4)}` : `${x}–${y}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** A leg's times are only stated when its arrival day is known (overnight / time-zone legs fall through). */
function timed(c: LegChoice | null): c is LegChoice {
  if (!c || !c.departTime || !c.arriveTime) return false;
  return !!c.arriveDate || c.arriveTime > c.departTime;
}
function legTimes(c: LegChoice): string {
  const arr = c.arriveDate && c.departDate && c.arriveDate !== c.departDate ? `${shortDate(c.arriveDate)} at ${c.arriveTime}` : `at ${c.arriveTime}`;
  return `leaves at ${c.departTime} and arrives ${arr}`;
}
const operatorWords = (c: LegChoice) => (c.operator ? ` — ${c.operator}${c.mode === 'train' ? ' train' : ''}` : '');

/** The trip city a captured name means: exactly one, by equality. */
function cityByName(trip: any, captured: string): { c: any; i: number } | null {
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  const want = fold(captured);
  const hits = cities.map((c, i) => ({ c, i })).filter(({ c }) => fold(String(c?.name ?? '')) === want);
  return hits.length === 1 ? hits[0] : null;
}
const hotelName = (c: any): string | null =>
  c?.customHotel?.name || (Array.isArray(c?.hotels) ? c.hotels[c.selectedHotelIndex ?? 0]?.name : null) || c?.hotel?.name || null;

/**
 * A template answer, or null. Conservative: one anchored pattern for the
 * whole message, one sentence, every field present, nothing ambiguous.
 */
export function tier0(message: string, trip: any, history: ChatTurn[] = []): Tier0 | null {
  if (prefilterBlocksTier0(message, history)) return null;
  const raw = fold(message);
  if (raw.length > 80 || /,|;| and |\balso\b/.test(raw)) return null;
  const m = stripEnd(raw);
  if (m.includes('?')) return null;
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  const legs = tripLegs(trip);
  let x: RegExpExecArray | null;

  // home_time / out_time
  if ((x = /^(?:what time|when) (?:is|does) (?:our|my|the) (flight|train) (home|back|out|there)(?: leave)?$/.exec(m))) {
    const kind = x[2] === 'home' || x[2] === 'back' ? 'return' : 'outbound';
    const hits = legs.filter((l) => l.kind === kind);
    if (hits.length !== 1) return null;
    const leg = hits[0];
    const c = leg.current;
    if (!timed(c) || c.mode !== x[1] || !(c.departDate ?? leg.date)) return null;
    return { intent: kind === 'return' ? 'home_time' : 'out_time', reply: `${cap(legPhrase(leg))} ${legTimes(c)} on ${shortDate(c.departDate ?? leg.date)}${operatorWords(c)}.` };
  }

  // hotel_in
  if ((x = /^(?:which|what) hotel (?:are we|am i|is it|do we have)? ?(?:staying )?(?:at )?in (.+)$/.exec(m))) {
    const hit = cityByName(trip, x[1]);
    const name = hit && hotelName(hit.c);
    const a = hit?.c?.dates?.arrival;
    const d = hit?.c?.dates?.departure;
    if (!hit || !name || !a || !d) return null;
    return { intent: 'hotel_in', reply: `In ${hit.c.name} you're staying at ${name} (${fmtRange(a, d)}).` };
  }

  // arrive_in / leave_c
  if ((x = /^when (?:do|will) (?:we|i) (?:get|arrive) (?:to|in|at) (.+)$/.exec(m)) || (x = /^when (?:do|will) (?:we|i) leave (.+)$/.exec(m))) {
    const arriving = /\b(?:get|arrive)\b/.test(m);
    const hit = cityByName(trip, x[1]);
    if (!hit) return null;
    const day = arriving ? hit.c?.dates?.arrival : hit.c?.dates?.departure;
    if (!day) return null;
    const leg = legs.find((l) =>
      arriving
        ? (hit.i === 0 ? l.kind === 'outbound' : l.kind === 'intercity' && l.index === hit.i - 1)
        : (hit.i === cities.length - 1 ? l.kind === 'return' : l.kind === 'intercity' && l.index === hit.i),
    );
    const c = leg?.current ?? null;
    if (!leg || !timed(c)) return null;
    // The leg must travel on the day the stay says (overnight legs fall through).
    const legDay = arriving ? (c.arriveDate ?? c.departDate ?? leg.date) : (c.departDate ?? leg.date);
    if (legDay !== day) return null;
    const verb = arriving ? `You arrive in ${hit.c.name}` : `You leave ${hit.c.name}`;
    return {
      intent: arriving ? 'arrive_in' : 'leave_c',
      reply: `${verb} on ${shortDate(day)}: ${cap(legPhrase(leg))} ${legTimes(c)}${operatorWords(c)}.`,
    };
  }

  // nights_in
  if ((x = /^how many nights (?:are we|am i|do we have) (?:staying )?in (.+)$/.exec(m))) {
    const hit = cityByName(trip, x[1]);
    const a = hit?.c?.dates?.arrival;
    const d = hit?.c?.dates?.departure;
    if (!hit || !a || !d) return null;
    const n = nightsBetween(a, d);
    if (!(n >= 0)) return null;
    return { intent: 'nights_in', reply: `${n} night${n === 1 ? '' : 's'} in ${hit.c.name} (${fmtRange(a, d)}).` };
  }

  // leg_len
  if ((x = /^how long is the (train|flight) from (.+) to (.+)$/.exec(m))) {
    const from = fold(x[2]);
    const to = fold(x[3]);
    const hits = legs.filter((l) => fold(l.from) === from && fold(l.to) === to);
    if (hits.length !== 1) return null;
    const leg = hits[0];
    const c = leg.current;
    if (!c || c.mode !== x[1] || !c.duration) return null;
    const op = c.operator;
    const times = timed(c) ? ` (${c.departTime} → ${c.arriveTime}${op ? `, ${op}` : ''})` : op ? ` (${op})` : '';
    return { intent: 'leg_len', reply: `${leg.from} → ${leg.to} is ${c.duration} by ${c.mode}${times}.` };
  }

  // cities
  if (/^(?:what|which) cities (?:are we|am i) (?:visiting|going to|seeing)$/.test(m)) {
    if (!cities.length || cities.some((c) => !c?.name || !c?.dates?.arrival || !c?.dates?.departure)) return null;
    const list = cities.map((c) => `${c.name} (${fmtRange(c.dates.arrival, c.dates.departure)})`);
    return { intent: 'cities', reply: `Your trip: ${list.join(', then ')}.` };
  }
  return null;
}

/** History reasons that rule out a template even when the pattern matches. */
function prefilterBlocksTier0(message: string, history: ChatTurn[]): boolean {
  const p = prefilter(message, history);
  return !!p && ['after_proposal', 'back_reference', 'short_followup', 'unnamed_leg'].includes(p.rule);
}

// ─── Tier 1: Haiku answers or escalates ──────────────────────────────

const TIER1_TOOLS = [
  {
    name: 'answer',
    description: 'Answer the traveller, ONLY from TRIP CONTEXT. 1–3 short sentences.',
    input_schema: { type: 'object' as const, properties: { answer: { type: 'string' } }, required: ['answer'] },
  },
  {
    name: 'escalate',
    description: 'Hand the question to the full assistant. Always acceptable; a wrong answer is not.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', enum: ['change', 'search', 'compare', 'weather_packing', 'dinner', 'price', 'not_in_trip', 'needs_history', 'judgement', 'unsure'] },
      },
      required: ['reason'],
    },
  },
];
export const TIER1_TOOL_NAMES = TIER1_TOOLS.map((t) => t.name);

export const TIER1_INSTRUCTIONS = `You are the quick-answer desk of BlueMurr AI, a trip-planning assistant. You get ONE question about the traveller's trip and must call exactly one tool.

Call "answer" ONLY when the answer is literally in TRIP CONTEXT (cities, dates, nights, hotel names, the legs' times, operators, durations, stops) or in the CALENDAR note, and the question asks for nothing else.

Call "escalate" when the traveller:
- wants anything changed, searched, compared, booked, added or removed, or asks what they could or should do;
- asks about weather, what to pack or wear, restaurants or dinner;
- asks about any price, cost, fare or saving;
- asks why something is the way it is, or for advice or an opinion;
- asks about anything not literally in TRIP CONTEXT (sights, activities, opening hours, visas, distances);
- refers to an earlier message ("that one", "the other flight");
- or you are not sure. Escalating is always acceptable; a wrong answer is not.

When you answer: copy times, dates and names exactly as TRIP CONTEXT has them; say weekdays only as the CALENDAR note gives them; never claim you changed or booked anything; plain text, 1–3 sentences, no markdown.`;

/** "Tue Jan 12 = 2027-01-12" for every day of the trip, so the model never works out a weekday. */
export function calendarNote(trip: any): string {
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  const first = cities[0]?.dates?.arrival;
  const last = cities[cities.length - 1]?.dates?.departure;
  if (!first || !last) return '';
  const days: string[] = [];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let d = addDays(String(first), -1); d <= addDays(String(last), 1) && days.length < 70; d = addDays(d, 1)) {
    days.push(`${WD[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${shortDate(d)} = ${d}`);
  }
  return `CALENDAR: ${days.join('; ')}`;
}

const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Why a tier-1 answer can't be used, or null. `contextText` is everything the
 * model was shown (trip block + calendar note).
 */
export function guardProblem(answer: string, trip: any, contextText: string): string | null {
  const a = String(answer ?? '');
  if (!a.trim()) return 'empty';
  if (a.length > 600) return 'too_long';
  if (/\$|€|£|\bUSD\b|\bdollars?\b|\beuros?\b/i.test(a)) return 'money';
  if (/\b(?:changed|updated|switched|booked|added|removed|moved|reserved|cancelled|canceled)\b/i.test(a)) return 'claims_change';
  if (/°|\b(?:rain|raining|sunny|temperature|forecast|degrees|cold|warm|snow)\b/i.test(a)) return 'weather';
  // Every number must be one the model was shown.
  for (const n of a.match(/\d{1,2}:\d{2}|\d+h(?: \d+m)?|\d+m\b|\d+/g) ?? []) {
    if (!contextText.includes(n)) return `number_not_in_context:${n}`;
  }
  // "Jan 14" must be a date the trip context or calendar has; a weekday next to it must agree.
  for (const d of a.matchAll(/\b(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,? )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})\b/gi)) {
    const mon = MONTHS.indexOf(d[2].toLowerCase()) + 1;
    const mmdd = `-${String(mon).padStart(2, '0')}-${String(Number(d[3])).padStart(2, '0')}`;
    const iso = (contextText.match(new RegExp(`\\d{4}${mmdd}`)) ?? [])[0];
    if (!iso) return `date_not_in_context:${d[0]}`;
    if (d[1] && new Date(`${iso}T12:00:00Z`).getUTCDay() !== WEEKDAYS[d[1].toLowerCase()]) return `weekday_wrong:${d[0]}`;
  }
  // No city outside the trip (and home).
  const known = new Set<string>([
    ...(Array.isArray(trip?.cities) ? trip.cities : []).map((c: any) => fold(String(c?.name ?? ''))),
    fold(String(trip?.origin?.city ?? '')),
    fold(String(trip?.origin?.returnCity ?? '')),
  ]);
  for (const w of a.match(/\b[A-Z][a-zà-ÿ]+(?: [A-Z][a-zà-ÿ]+)?\b/g) ?? []) {
    if (getCityCountry(w) && !known.has(fold(w)) && !contextText.includes(w)) return `city_not_in_trip:${w}`;
  }
  return null;
}

export type Tier1 =
  | { verdict: 'answer'; reply: string; usage?: any }
  | { verdict: 'escalate'; reason: string; usage?: any };

/** One Haiku call: an answer that passed the guard, or an escalation. Never throws. */
export async function tier1(
  anthropic: any,
  trip: any,
  tripBlock: string,
  message: string,
  history: ChatTurn[],
): Promise<Tier1> {
  const cal = calendarNote(trip);
  const params = {
    model: TIER1_MODEL,
    max_tokens: 400,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system: [
      { type: 'text', text: TIER1_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: tripBlock, cache_control: { type: 'ephemeral' } },
    ],
    tools: TIER1_TOOLS,
    messages: [
      ...realHistory(history).map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: `${message}\n\n(${cal})` },
    ],
  };
  let res: any;
  try {
    res = await createMessage(anthropic, 'chat_route', params, { tier: 1 });
  } catch (err: any) {
    logger.warn('chat route: tier-1 call failed', { message: err?.message });
    return { verdict: 'escalate', reason: 'tier1_error' };
  }
  const usage = res?.usage;
  const uses = (res?.content ?? []).filter((b: any) => b.type === 'tool_use');
  if (res?.stop_reason === 'max_tokens' || uses.length !== 1) return { verdict: 'escalate', reason: 'malformed', usage };
  const use = uses[0];
  if (use.name === 'escalate') return { verdict: 'escalate', reason: String(use.input?.reason ?? 'unsure'), usage };
  if (use.name !== 'answer') return { verdict: 'escalate', reason: 'unknown_tool', usage };
  const reply = String(use.input?.answer ?? '').trim();
  const problem = guardProblem(reply, trip, `${tripBlock}\n${cal}\n${message}`);
  if (problem) return { verdict: 'escalate', reason: `guard:${problem}`, usage };
  return { verdict: 'answer', reply, usage };
}

// ─── The router ──────────────────────────────────────────────────────

export type RouteDecision = {
  tier: 0 | 1 | 2;
  /** Tiers 0 / 1: the reply to send. */
  reply?: string;
  /** Why: tier-0 intent, pre-filter rule, tier-1 escalation reason. */
  reason: string;
};

/**
 * Pick a tier and, for tiers 0 / 1, the answer. Tier 2 means "run today's
 * path". Never throws. `tripBlock` is the per-trip system block Sonnet gets.
 */
export async function routeChat(ctx: {
  anthropic: any;
  trip: any;
  tripBlock: string;
  message: string;
  history?: ChatTurn[];
}): Promise<RouteDecision> {
  const history = ctx.history ?? [];
  try {
    const t0 = tier0(ctx.message, ctx.trip, history);
    if (t0) return { tier: 0, reply: t0.reply, reason: t0.intent };
    const pf = prefilter(ctx.message, history);
    if (pf) return { tier: 2, reason: `prefilter:${pf.rule}` };
    // Per-person mode: tier 1 never states money anyway, but say so in the reason for the logs.
    const t1 = await tier1(ctx.anthropic, ctx.trip, ctx.tripBlock, ctx.message, history);
    if (t1.verdict === 'answer') return { tier: 1, reply: t1.reply, reason: perPersonWord() ? 'answer:per_person' : 'answer' };
    return { tier: 2, reason: `escalate:${t1.reason}` };
  } catch (err: any) {
    logger.warn('chat route failed; using tier 2', { message: err?.message });
    return { tier: 2, reason: 'router_error' };
  }
}

/** Times, dates and numbers in a reply, for shadow-mode agreement without logging text. */
export function factTokens(s: string): string[] {
  return [...new Set((String(s ?? '').match(/\d{1,2}:\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}|\d+h(?: \d+m)?|\d+/gi) ?? []).map((x) => x.toLowerCase()))];
}

/**
 * Shadow verdict: would routing have been safe here? `sonnetTool` is the
 * tool tier 2 actually chose; `sonnetReply` its reply.
 */
export function shadowAgreement(d: RouteDecision, sonnetTool: string | null, sonnetReply: string): 'safe' | 'DANGEROUS' | 'missed_saving' | 'tier2_both' {
  const sonnetAnswered = sonnetTool === 'answer_only' || sonnetTool === null;
  if (d.tier === 2) return sonnetAnswered ? 'missed_saving' : 'tier2_both';
  if (!sonnetAnswered) return 'DANGEROUS';
  const mine = factTokens(d.reply ?? '');
  const theirs = new Set(factTokens(sonnetReply));
  return mine.every((t) => theirs.has(t)) ? 'safe' : 'DANGEROUS';
}

export type { TripLeg };
