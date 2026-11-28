import type { Co2Figure, DoorToDoor, RailPriceSource, Transport } from './types';

/**
 * Door-to-door time, CO₂ and fare provenance for a leg — the numbers come
 * from the backend (services/legFacts.ts, trains.ts); this file only carries
 * them onto a Transport and words them for the leg card.
 */

type FactSource = {
  doorToDoor?: DoorToDoor | null;
  co2?: Co2Figure | null;
  priceSource?: RailPriceSource;
};

/** The facts an offer/option carries, as Transport fields — only those present. */
export function pickLegFacts(src: FactSource | null | undefined, mode: 'flight' | 'train'): Partial<Transport> {
  if (!src) return {};
  const out: Partial<Transport> = {};
  if (src.doorToDoor && src.doorToDoor.totalMinutes > 0) out.doorToDoor = src.doorToDoor;
  if (src.co2 && Number.isFinite(src.co2.kg) && src.co2.kg > 0) out.co2 = src.co2;
  // A price source only means something on a rail fare.
  if (mode === 'train' && src.priceSource) out.priceSource = src.priceSource;
  return out;
}

/** The leg's train and flight: the shown option, and the first of the other mode among its alternatives. */
export function legModes(t: Transport): { train: Transport | null; flight: Transport | null } {
  const all = [t, ...(t.alternatives ?? [])];
  return {
    train: all.find((x) => x.mode === 'train') ?? null,
    flight: all.find((x) => x.mode === 'flight') ?? null,
  };
}

/**
 * How much less CO₂ the train emits than the flight, as a whole percent —
 * null unless both are known and the train really is lower.
 */
export function trainCo2SavingPct(
  train: Co2Figure | null | undefined,
  flight: Co2Figure | null | undefined,
): number | null {
  if (!train || !flight || !(flight.kg > 0) || !(train.kg >= 0)) return null;
  const pct = Math.round(((flight.kg - train.kg) / flight.kg) * 100);
  return pct > 0 ? pct : null;
}

/** "12 kg", "1.4 t" — whole kilograms are precise enough for an estimate. */
export function formatCo2(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  return `${Math.max(1, Math.round(kg))} kg`;
}

/** How a CO₂ figure was arrived at, for the line under it. */
export function co2Basis(c: Co2Figure): string {
  if (c.source === 'duffel') return 'airline itinerary estimate (Duffel)';
  const g = c.gramsPerPassengerKm != null ? Math.round(c.gramsPerPassengerKm) : null;
  return c.distanceKm != null && g != null
    ? `estimate: ~${c.distanceKm} km × ${g} g/passenger-km`
    : 'estimate from distance';
}

export type PriceLabel = { text: string; tone: 'live' | 'muted'; title: string };

/**
 * What a rail price says about where it came from. "Live" only for a fare a
 * provider returned for this search; everything else says what it is.
 */
export function railPriceLabel(src: RailPriceSource | undefined): PriceLabel {
  if (!src) {
    return {
      text: 'Fare source not recorded',
      tone: 'muted',
      title: 'This leg was priced before BlueMurr recorded where rail fares come from.',
    };
  }
  if (src.kind === 'live') {
    const by = src.provider ? ` · ${src.provider}` : '';
    return src.testApi
      ? {
          text: `Live fare${by} (test API)`,
          tone: 'live',
          title: `Fare returned for this search by ${src.provider ?? 'the rail provider'}'s test gateway. Booking isn't connected yet.`,
        }
      : {
          text: `Live fare${by}`,
          tone: 'live',
          title: `Fare returned for this search by ${src.provider ?? 'the rail provider'}.`,
        };
  }
  if (src.kind === 'cached') {
    return {
      text: 'Recent fare · cached',
      tone: 'muted',
      title: 'A live fare from a search in the last 2 hours.',
    };
  }
  return {
    text: 'Estimated fare',
    tone: 'muted',
    title: 'Not a quote from a rail provider.',
  };
}

/** The few words under a leg chip: a train's fare provenance, or null to keep the default hint. */
export function railPriceShort(src: RailPriceSource | undefined): string | null {
  if (!src) return null;
  if (src.kind === 'live') return 'Live fare';
  if (src.kind === 'cached') return 'Recent fare';
  return 'Est. fare';
}
