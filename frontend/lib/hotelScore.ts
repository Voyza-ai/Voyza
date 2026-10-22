import { Hotel } from './types';

/**
 * BlueMurr hotel ranking formula.
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
export function hotelScore(
  h: {
    rating: number;
    locationScore?: number;
    pricePerNight: number;
    reviewCount?: number;
  },
  priorMeanRating?: number,
): number {
  const loc = typeof h.locationScore === 'number' ? h.locationScore : 0.7;
  const safePrice = Math.max(1, h.pricePerNight);
  const ratingTerm = Math.pow(effectiveRating(h, priorMeanRating), 2.8);
  const locTerm = 0.8 + 0.2 * loc;
  const priceTerm = 100 / safePrice;
  return ratingTerm * locTerm * priceTerm;
}

/**
 * Reviews needed before a hotel's own rating is taken at close to face value.
 *
 * Against a real Florence search, counts ran 8 to 20,721 with a median of 640 —
 * so at 50 the typical hotel is barely touched (640/690 ≈ 93% its own number)
 * while an 8-review listing is heavily discounted (8/58 ≈ 14%).
 */
const REVIEW_CONFIDENCE_WEIGHT = 50;

/**
 * A rating discounted for how much evidence stands behind it.
 *
 * `rating^2.8` treats every rating as equally believable, so a 9.5 from 3
 * reviews beat a 9.3 from 640. This shrinks a thin rating toward the prior
 * mean in proportion to its review count — the standard Bayesian average.
 *
 * The `Math.min` is the part that isn't standard, and it's deliberate.
 * Textbook shrinkage is symmetric: it correctly deflates an inflated thin
 * rating, but it equally inflates a *below average* one. Measured on the same
 * Florence set, a hotel rated 8.5 from 8 reviews was pulled UP to 8.94 against
 * a mean of 8.97 and climbed from 5th to 2nd — the opposite of the point.
 *
 * Thin evidence is a reason for doubt, never for credit, so it can only cost
 * a hotel, never earn it anything.
 */
function effectiveRating(
  h: { rating: number; reviewCount?: number },
  priorMeanRating?: number,
): number {
  const v = h.reviewCount;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return h.rating;
  if (typeof priorMeanRating !== 'number' || !Number.isFinite(priorMeanRating)) return h.rating;

  const m = REVIEW_CONFIDENCE_WEIGHT;
  const shrunk = (v * h.rating + m * priorMeanRating) / (v + m);
  return Math.min(h.rating, shrunk);
}

/**
 * Sorts hotels by score descending and stamps each one with its computed score.
 *
 * Generic over the input shape so the API layer can rank a `HotelResult`
 * straight off the wire without first narrowing it to `Hotel` — ranking at that
 * boundary is what makes `hotels[0]` mean "best" for every caller.
 */
export function rankHotels<
  T extends {
    rating: number;
    locationScore?: number;
    pricePerNight: number;
    reviewCount?: number;
  },
>(hotels: T[]): (T & { score: number })[] {
  // The prior comes from the set itself rather than a constant, so it travels
  // across rating scales — Booking.com returns out of 10, the demo data out
  // of 5 — without either needing to be detected.
  const ratings = hotels.map((h) => h.rating).filter((r) => Number.isFinite(r));
  const priorMeanRating = ratings.length
    ? ratings.reduce((s, r) => s + r, 0) / ratings.length
    : undefined;

  return hotels
    .map((h) => ({ ...h, score: hotelScore(h, priorMeanRating) }))
    .sort((a, b) => b.score - a.score);
}

/** Number of nights between two ISO yyyy-mm-dd dates (local). */
export function nightsBetween(arrival: string, departure: string): number {
  if (!arrival || !departure) return 0;
  const [ay, am, ad] = arrival.split('-').map(Number);
  const [dy, dm, dd] = departure.split('-').map(Number);
  if (isNaN(ay) || isNaN(dy)) return 0;
  const a = new Date(ay, am - 1, ad).getTime();
  const d = new Date(dy, dm - 1, dd).getTime();
  return Math.max(0, Math.round((d - a) / (1000 * 60 * 60 * 24)));
}
