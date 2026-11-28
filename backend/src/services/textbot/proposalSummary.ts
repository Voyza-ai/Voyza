import { applyCityEdit, liveTripTotalFrontend } from './tripEdits';

/**
 * What a YES would change, in a few text lines. The website shows this on its
 * proposal card (cityEditDiff / the date-shift diff); a text must say it too,
 * so nobody confirms blind. Computed with the website's own functions.
 *
 * transport_change replies already carry "Trip total $A → $B" (tripChat
 * writes it from checked data), so nothing is added for those.
 */
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${money(Math.abs(n))}`;
/** "Trip total $A → $B (±$C)" with C = B − A of the ROUNDED figures, so it always adds up. */
const totalLine = (before: number, after: number) => {
  const a = Math.round(before);
  const b = Math.round(after);
  return `Trip total ${money(a)} → ${money(b)} (${signed(b - a)}).`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : iso;
};
const stays = (cities: any[]) =>
  cities.map((c: any) => `${c.name} ${shortDate(c.dates?.arrival)}–${shortDate(c.dates?.departure)}`).join(', ');

export function proposalImpact(trip: any, result: any, reply: string): string {
  const p = result?.proposal;
  if (result?.type !== 'proposal' || !p || /Trip total \$/.test(reply)) return '';
  try {
    const before = liveTripTotalFrontend(trip);
    if (p.kind === 'city_edit') {
      const next = applyCityEdit(trip, p);
      const lines = [`Trip: ${stays(next.cities)}.`];
      for (const l of p.legs ?? []) {
        const o = l.options?.[0];
        lines.push(
          o
            ? `${l.from} → ${l.to}: ${[o.mode, o.operator, money(o.price ?? 0)].filter(Boolean).join(' ')}.`
            : `${l.from} → ${l.to}: nothing found yet.`,
        );
      }
      lines.push(totalLine(before, next.totalCost));
      return lines.join('\n');
    }
    if (p.kind === 'date_shift' && Array.isArray(p.proposedTrip?.cities)) {
      const after = liveTripTotalFrontend(p.proposedTrip);
      return `Trip: ${stays(p.proposedTrip.cities)}.\n${totalLine(before, after)}`;
    }
  } catch {
    return '';
  }
  return '';
}
