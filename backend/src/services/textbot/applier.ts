import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../supabase';
import { liveTripTotal } from '../../utils/tripShape';
import type { ChatResult, ProposalApplier, TripLoader } from './types';

/**
 * Saves a texted YES to the trip, so it shows on the website.
 *
 * Scope today: flight swaps on the HOME legs (flight out / flight home) that
 * don't move any stay dates — "find us a later flight home", "a cheaper
 * flight out". Everything else (inter-city legs, a new outbound that lands
 * another day, city and date edits) is refused with "accept it on the
 * website", and nothing is written.
 *
 * How it applies mirrors the website's Accept (frontend/lib/transportChange.ts
 * applyTransportChange, home-leg branch): the chosen option becomes the leg's
 * selection, the old one goes first among its alternatives (max 4), and the
 * user's choice is recorded. trips.total_cost is the live total (same rule as
 * the canvas save, utils/tripShape liveTripTotal).
 *
 * Safety: ONE UPDATE … WHERE id = ? AND updated_at = <version the proposal was
 * priced on>. If the trip was saved anywhere since (an open website tab,
 * another text), zero rows match, nothing changes, and Blue says so.
 */

const MAX_ALTERNATIVES = 4;
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const samePrice = (a: unknown, b: unknown) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
const eqOpt = (a: string | null | undefined, b: string | null | undefined) => !a || !b || a.toUpperCase() === b.toUpperCase();

type LegChoice = {
  mode: 'flight' | 'train';
  operator: string;
  flightNumber: string | null;
  departTime: string | null;
  arriveTime: string | null;
  departDate: string | null;
  arriveDate: string | null;
  fromAirport: string | null;
  toAirport: string | null;
  durationMinutes: number;
  stops: number;
  price: number;
  currency: string;
  bookingUrl: string | null;
};

/** Same test as frontend choiceMatchesHomeLeg. */
export function choiceMatchesHomeLeg(c: LegChoice, h: any): boolean {
  if (!c || !h) return false;
  return (
    norm(c.operator) === norm(h.operator) &&
    (c.departTime ?? null) === (h.departTime ?? null) &&
    eqOpt(c.departDate, h.departDate) &&
    eqOpt(c.fromAirport, h.originAirport) &&
    eqOpt(c.toAirport, h.destAirport) &&
    samePrice(c.price, h.price)
  );
}

function choiceToHomeLeg(c: LegChoice, fallbackDate: string | null): any {
  return {
    originAirport: c.fromAirport ?? '',
    destAirport: c.toAirport ?? '',
    price: c.price,
    currency: c.currency || 'USD',
    durationMinutes: c.durationMinutes,
    operator: c.operator,
    carrierCode: c.flightNumber ?? '',
    departTime: c.departTime,
    arriveTime: c.arriveTime,
    departDate: c.departDate ?? fallbackDate ?? '',
    ...(c.arriveDate ? { arriveDate: c.arriveDate } : {}),
    stops: c.stops,
    bookingUrl: c.bookingUrl,
  };
}

const flatHome = (h: any) => {
  const { alternatives: _a, userChoice: _u, ...rest } = h ?? {};
  return rest;
};

/** Same as frontend preferenceFromProposal. */
function preferenceFromProposal(p: any) {
  const req = p.request ?? {};
  const w = req.window ?? {};
  const before = p.before?.departTime ?? null;
  return {
    source: 'chat',
    departTime: p.after?.departTime ?? null,
    operator: p.after?.operator || null,
    timeOfDay: req.timeOfDay ?? null,
    earliestDepart: w.earliestDepart ?? (req.relative === 'later' ? before : null),
    latestDepart: w.latestDepart ?? (req.relative === 'earlier' ? before : null),
    earliestArrive: w.earliestArrive ?? null,
    latestArrive: w.latestArrive ?? null,
  };
}

/** The home leg with `after` selected (frontend applyTransportChange, home branch). */
export function switchHomeLeg(current: any, p: any): any {
  const alts: any[] = current?.alternatives ?? [];
  const at = alts.findIndex((a) => choiceMatchesHomeLeg(p.after, a));
  const chosen = at >= 0 ? alts[at] : choiceToHomeLeg(p.after, p.leg?.date ?? null);
  const rest = alts.filter((_, k) => k !== at);
  const nextAlts = (current ? [flatHome(current), ...rest] : rest).slice(0, MAX_ALTERNATIVES);
  return { ...chosen, ...(nextAlts.length > 0 ? { alternatives: nextAlts } : {}), userChoice: preferenceFromProposal(p) };
}

const WEBSITE_ONLY = 'this kind of change can only be accepted on the website for now';

export class TripProposalApplier implements ProposalApplier {
  constructor(
    private trips: TripLoader,
    private db: SupabaseClient = getSupabase(),
    private now: () => number = () => Date.now(),
  ) {}

  async apply(tripId: string, result: ChatResult, _byUserId: string, expectedUpdatedAt: string | null) {
    const p: any = (result as any).proposal;
    if (result.type !== 'proposal' || p?.kind !== 'transport_change') return { ok: false as const, reason: WEBSITE_ONLY };
    if (p.leg?.kind !== 'outbound' && p.leg?.kind !== 'return') return { ok: false as const, reason: WEBSITE_ONLY };
    if (p.firstStay) return { ok: false as const, reason: `it also moves your ${p.firstStay.city} arrival date, so ${WEBSITE_ONLY}` };
    if (!expectedUpdatedAt) return { ok: false as const, reason: "I couldn't tell which version of the trip it was priced on" };

    const loaded = await this.trips.load(tripId);
    if (!loaded) return { ok: false as const, reason: "I can't find the trip any more" };
    const trip: any = loaded.trip;
    const changed = "the trip was changed since I suggested this (maybe on the website). Ask me again and I'll re-check";
    if (loaded.updatedAt !== expectedUpdatedAt) return { ok: false as const, reason: changed };

    const slot = p.leg.kind === 'outbound' ? 'outboundLeg' : 'returnLeg';
    const cities: any[] = trip.cities ?? [];
    const city = p.leg.kind === 'outbound' ? cities[0] : cities[cities.length - 1];
    if (!trip.origin?.city || !city || norm(city.name) !== norm(p.leg.kind === 'outbound' ? p.leg.to : p.leg.from)) {
      return { ok: false as const, reason: changed };
    }
    const current = trip.origin?.[slot] ?? null;
    const stillApplies = p.before ? choiceMatchesHomeLeg(p.before, current) : current == null;
    if (!stillApplies) return { ok: false as const, reason: changed };

    const nextLeg = switchHomeLeg(current, p);
    const nextOrigin = { ...trip.origin, [slot]: nextLeg };
    const total = liveTripTotal(cities, nextOrigin);
    const column = slot === 'outboundLeg' ? 'outbound_leg' : 'return_leg';

    const { data, error } = await this.db
      .from('trips')
      .update({ [column]: nextLeg, total_cost: total, updated_at: new Date(this.now()).toISOString() })
      .eq('id', tripId)
      .eq('updated_at', expectedUpdatedAt)
      .select('id');
    if (error) return { ok: false as const, reason: 'saving failed on our side' };
    if (!data || data.length !== 1) return { ok: false as const, reason: changed };
    return { ok: true as const };
  }
}
