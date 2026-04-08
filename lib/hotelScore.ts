import { Hotel } from './types';

/**
 * Voyza hotel ranking formula.
 *
 *   score = rating^2.8 × (0.8 + 0.2 × locationScore) × (100 / pricePerNight)
 *
 * Design intent:
 *  - Rating dominates (exponent 2.8): a 4.5★ hotel beats a 4.2★ even at $15 more.
 *  - Location nudges, doesn't dominate: a perfectly central hotel gets a +25%
 *    multiplier vs a poorly located one (1.0 vs 0.8).
 *  - Price stays linear and meaningful: half the nightly rate ≈ 2× the price term.
 *
 * Sanity check (Rome demo):
 *   Casa Trastevere    4.5 / loc 0.80 / $110  → ≈ 58.8  (winner)
 *   Hotel Pantheon     4.2 / loc 0.95 / $95   → ≈ 57.9
 *   Termini Plaza      3.9 / loc 0.55 / $72   → ≈ 57.1
 *   Roma Boutique      4.7 / loc 0.70 / $145  → ≈ 49.3
 *   Villa Borghese     4.4 / loc 0.85 / $130  → ≈ 47.2
 */
export function hotelScore(h: {
  rating: number;
  locationScore?: number;
  pricePerNight: number;
}): number {
  const loc = typeof h.locationScore === 'number' ? h.locationScore : 0.7;
  const safePrice = Math.max(1, h.pricePerNight);
  const ratingTerm = Math.pow(h.rating, 2.8);
  const locTerm = 0.8 + 0.2 * loc;
  const priceTerm = 100 / safePrice;
  return ratingTerm * locTerm * priceTerm;
}

/** Sorts hotels by score descending and stamps each one with its computed score. */
export function rankHotels(hotels: Hotel[]): Hotel[] {
  return hotels
    .map((h) => ({ ...h, score: hotelScore(h) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Number of nights between two ISO yyyy-mm-dd dates (local). */
export function nightsBetween(arrival: string, departure: string): number {
  const [ay, am, ad] = arrival.split('-').map(Number);
  const [dy, dm, dd] = departure.split('-').map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const d = new Date(dy, dm - 1, dd).getTime();
  return Math.max(0, Math.round((d - a) / (1000 * 60 * 60 * 24)));
}
