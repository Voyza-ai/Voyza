/**
 * Client mirror of the backend pre-filter in
 * `backend/src/services/reviseDestinations.ts` (`mightBeRevision`).
 *
 * The guided planner only asks the server "is this a change to your
 * destinations?" when the message has a revision cue word or names a city
 * already on the trip. Everything else ("New York", "4 people") goes straight
 * to the current step with no extra round-trip. Keep the two lists in step.
 */

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mightBeRevision(message: string, destinations: string[]): boolean {
  if (destinations.length === 0) return false;
  if (/\b(actually|instead|not|rather|change|swap|switch|replace|drop|remove|skip|cut|add|also|include|plus|meant|mean|typo)\b/i.test(message)) {
    return true;
  }
  const words = norm(message);
  return destinations.some((d) => {
    const dn = norm(d);
    return dn.length > 2 && new RegExp(`\\b${dn}\\b`).test(words);
  });
}
