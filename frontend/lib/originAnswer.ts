import { parseDateRangeInput } from './parseDate';

/**
 * Is an answer to "Where are you flying from?" clearly not a place?
 *
 * An audit (2026-11-18) typed "January 12 to 19, 2027" into that step and
 * the planner took it as the home city. Dates and bare numbers are refused
 * there with a short re-ask; anything else is left to the location resolver,
 * which already handles real but obscure places.
 *
 * Mirrored on the backend for the conversational planner
 * (services/homeAnswers.ts `originNotAPlace`).
 */
const MONTH = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const NUMERIC_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b/;
const RELATIVE = /^(today|tomorrow|tonight|this weekend|next (week|weekend|month|year)|in \d+ (days?|weeks?|months?))$/i;
const NUMBER_ONLY = /^[\d\s$€£¥.,+\-x×]+$/i;

export type NotAPlace = 'dates' | 'number';

export function originNotAPlace(text: string): NotAPlace | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (parseDateRangeInput(t)) return 'dates';
  if (MONTH.test(t) && /\d/.test(t)) return 'dates';
  if (NUMERIC_DATE.test(t)) return 'dates';
  if (RELATIVE.test(t)) return 'dates';
  if (NUMBER_ONLY.test(t)) return 'number';
  return null;
}

/** The re-ask for an answer that isn't a place. */
export function originReask(reason: NotAPlace, keptDates: boolean): string {
  if (reason === 'dates') {
    return keptDates
      ? "That looks like dates — I've noted them. Which city are you flying from?"
      : 'That looks like dates — which city are you flying from?';
  }
  return "That doesn't look like a city — which city are you flying from?";
}
