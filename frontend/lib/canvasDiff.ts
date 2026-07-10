/**
 * Human summary of what a proposed canvas state changes vs the canonical
 * one — shown on the owner's approve/reject card for suggester proposals
 * ("owner confirms edits" share mode). Compact by design: one line per
 * kind of change, capped.
 */

type AnyCity = {
  name: string;
  dates?: { arrival?: string; departure?: string };
  hotel?: { name?: string };
  hotels?: Array<{ name?: string }>;
  selectedHotelIndex?: number;
  customHotel?: { name?: string };
};

type AnyState = {
  cities?: AnyCity[];
  trip?: { origin?: { city?: string } | null; returnToHome?: boolean };
};

const MAX_LINES = 6;

function nightsOf(c: AnyCity): number | null {
  const a = c.dates?.arrival;
  const d = c.dates?.departure;
  if (!a || !d) return null;
  const ms = new Date(d).getTime() - new Date(a).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86400000);
}

function hotelNameOf(c: AnyCity): string | null {
  if (c.customHotel?.name) return c.customHotel.name;
  const h = c.hotels?.[c.selectedHotelIndex ?? 0] ?? c.hotel;
  return h?.name ?? null;
}

export function summarizeCanvasChanges(before: AnyState | null, after: AnyState | null): string[] {
  const lines: string[] = [];
  const b = before?.cities ?? [];
  const a = after?.cities ?? [];
  const bNames = b.map((c) => c.name);
  const aNames = a.map((c) => c.name);

  for (const name of aNames) {
    if (!bNames.includes(name)) lines.push(`Add ${name}`);
  }
  for (const name of bNames) {
    if (!aNames.includes(name)) lines.push(`Remove ${name}`);
  }

  // Reorder — same membership, different order
  const common = aNames.filter((n) => bNames.includes(n));
  const bCommon = bNames.filter((n) => aNames.includes(n));
  if (common.length > 1 && common.join('|') !== bCommon.join('|')) {
    lines.push(`Reorder to ${aNames.join(' → ')}`);
  }

  // Per-city changes for cities present on both sides
  for (const city of a) {
    const prev = b.find((c) => c.name === city.name);
    if (!prev) continue;
    const nb = nightsOf(prev);
    const na = nightsOf(city);
    if (nb != null && na != null && nb !== na) {
      lines.push(`${city.name}: ${nb} → ${na} night${na === 1 ? '' : 's'}`);
    }
    const hb = hotelNameOf(prev);
    const ha = hotelNameOf(city);
    if (hb && ha && hb !== ha) {
      lines.push(`${city.name}: hotel → ${ha}`);
    }
  }

  // Origin change
  const ob = before?.trip?.origin?.city ?? null;
  const oa = after?.trip?.origin?.city ?? null;
  if (ob !== oa) {
    lines.push(oa ? `Home city → ${oa}` : 'Remove home city');
  }

  if (lines.length === 0) return ['Small tweaks (no structural changes)'];
  if (lines.length > MAX_LINES) {
    return [...lines.slice(0, MAX_LINES), `+${lines.length - MAX_LINES} more change${lines.length - MAX_LINES === 1 ? '' : 's'}`];
  }
  return lines;
}
