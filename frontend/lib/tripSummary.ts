import type { PlanningAnswers } from './types';

/**
 * The running trip summary on /plan: what the traveller has told us so far,
 * written as one readable line ("Culture trip to Venice & Rome from New York
 * · Round-trip · 2 people · $3k total · Dec 10 – 16 · 6 nights") rather than
 * a list of fields.
 *
 * Each fact keeps the answer it came from (`field`) so the card can make it
 * clickable for revising that answer.
 */
export type SummaryField =
  | 'vibe'
  | 'destinations'
  | 'origin'
  | 'returnToHome'
  | 'travelers'
  | 'budget'
  | 'dates'
  | 'nights'
  | 'notes';

/** One clickable piece of the line. `text` is what is shown. */
export type SummaryPart = { field: SummaryField; text: string };

/**
 * A group of parts read as one phrase ("Culture trip to Venice & Rome from
 * New York"): `parts` alternate with the plain words in `glue`, which are
 * not clickable. Groups are separated by " · ".
 */
export type SummaryGroup = { key: string; pieces: Array<string | SummaryPart> };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isSet = (s: string | undefined | null): s is string => typeof s === 'string' && s.trim().length > 0;

/** "Venice", "Venice & Rome", "Venice, Rome & Florence". */
export function joinCities(cities: string[]): string {
  const c = cities.map((x) => x.trim()).filter(Boolean);
  if (c.length <= 1) return c[0] ?? '';
  return `${c.slice(0, -1).join(', ')} & ${c[c.length - 1]}`;
}

/** "$3k", "$2.5k", "$800", "$12k". */
export function shortMoney(amount: number): string {
  if (amount >= 1000) {
    const k = Math.round(amount / 100) / 10;
    return `$${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `$${Math.round(amount)}`;
}

/**
 * "Dec 10 – 16", "Dec 28 – Jan 3", "Jun 15", with the year only when it
 * isn't this year. Non-ISO answers ("Next month") are shown as typed.
 */
export function shortDateRange(start: string, end: string | undefined, now = new Date()): string {
  if (!ISO_DAY.test(start)) return start.trim();
  const [y1, m1, d1] = start.split('-').map(Number);
  const year = (y: number) => (y !== now.getFullYear() ? `, ${y}` : '');
  if (!end || !ISO_DAY.test(end) || end === start) return `${MONTHS[m1 - 1]} ${d1}${year(y1)}`;
  const [y2, m2, d2] = end.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${MONTHS[m1 - 1]} ${d1} – ${d2}${year(y2)}`;
  if (y1 === y2) return `${MONTHS[m1 - 1]} ${d1} – ${MONTHS[m2 - 1]} ${d2}${year(y2)}`;
  return `${MONTHS[m1 - 1]} ${d1}, ${y1} – ${MONTHS[m2 - 1]} ${d2}, ${y2}`;
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "culture and food vibes" → "Culture and food"; long free text is cut. */
function vibeWord(v: string): string {
  const t = v.trim().replace(/\s+vibes?$/i, '').replace(/\s+/g, ' ');
  return capitalise(t.length > 28 ? `${t.slice(0, 27).trimEnd()}…` : t);
}

function noteText(n: string): string {
  const t = n.trim().replace(/\s+/g, ' ');
  return `“${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}”`;
}

/**
 * Turn the planner's answers into the summary line. Empty array = nothing
 * answered yet (the card stays hidden). Skipped answers ("No budget limit",
 * no dates) simply don't appear.
 */
export function summarizeAnswers(a: PlanningAnswers, now = new Date()): SummaryGroup[] {
  const groups: SummaryGroup[] = [];

  // ── Lead phrase: "<Vibe> trip to <cities> from <origin>" ──
  const lead: Array<string | SummaryPart> = [];
  const cities = (a.destinations ?? []).filter(isSet);
  const vibe = isSet(a.vibe) ? vibeWord(a.vibe) : null;
  if (vibe) lead.push({ field: 'vibe', text: vibe }, ' trip');
  if (cities.length) {
    lead.push(vibe ? ' to ' : 'Trip to ', { field: 'destinations', text: joinCities(cities) });
  }
  if (isSet(a.origin)) {
    lead.push(lead.length ? ' from ' : 'From ', { field: 'origin', text: a.origin.trim() });
  }
  if (lead.length) groups.push({ key: 'lead', pieces: lead });

  if (typeof a.returnToHome === 'boolean') {
    groups.push({
      key: 'roundtrip',
      pieces: [{ field: 'returnToHome', text: a.returnToHome ? 'Round-trip' : 'One-way' }],
    });
  }

  if (typeof a.travelers === 'number' && a.travelers > 0) {
    groups.push({
      key: 'travelers',
      pieces: [{ field: 'travelers', text: a.travelers === 1 ? 'Solo' : `${a.travelers} people` }],
    });
  }

  if (typeof a.budget === 'number' && a.budget > 0) {
    const per = a.budgetPerPerson === true ? ' budget per person' : a.budgetPerPerson === false ? ' total budget' : ' budget';
    groups.push({ key: 'budget', pieces: [{ field: 'budget', text: `${shortMoney(a.budget)}${per}` }] });
  }

  const start = a.dateRange?.start;
  if (isSet(start)) {
    const flexible = a.flexible === true && !ISO_DAY.test(start);
    const text = shortDateRange(start, a.flexible ? undefined : a.dateRange?.end, now);
    groups.push({
      key: 'dates',
      pieces: [{ field: 'dates', text: flexible ? capitalise(text) : a.flexible ? `Around ${text}` : text }],
    });
  }

  if (typeof a.nights === 'number' && a.nights > 0) {
    groups.push({ key: 'nights', pieces: [{ field: 'nights', text: `${a.nights} night${a.nights === 1 ? '' : 's'}` }] });
  }

  if (isSet(a.extraNotes)) {
    groups.push({ key: 'notes', pieces: [{ field: 'notes', text: noteText(a.extraNotes) }] });
  }

  return groups;
}

/** The whole line as plain text (for aria-labels and tests). */
export function summaryText(groups: SummaryGroup[]): string {
  return groups
    .map((g) => g.pieces.map((p) => (typeof p === 'string' ? p : p.text)).join(''))
    .join(' · ');
}

/**
 * What to put in the free-chat input when a fact is clicked there: the
 * conversational planner already understands revisions, so the click just
 * starts the sentence.
 */
export const CHAT_EDIT_PREFILL: Record<SummaryField, string> = {
  vibe: 'Change the vibe to ',
  destinations: 'Change my cities to ',
  origin: "I'm actually starting from ",
  returnToHome: 'Make it ',
  travelers: 'Change the number of people to ',
  budget: 'Change the budget to ',
  dates: 'Change the dates to ',
  nights: 'Make it ',
  notes: 'Also, ',
};
