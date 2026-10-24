import { Hotel } from './types';

/**
 * BlueMurr hotel ranking formula.
 *
 *   score = effectiveRating^2.8 × (100 / pricePerNight)
 *
 * Design intent:
 *  - Rating dominates (exponent 2.8): a 4.5★ hotel beats a 4.2★ even at $15 more.
 *  - Price stays linear and meaningful: half the nightly rate ≈ 2× the price term.
 *  - A rating is only worth its evidence — see `effectiveRating` below.
 *
 * A location term used to sit in the middle: `(0.8 + 0.2 × locationScore)`.
 * It was removed because nothing ever fed it. The Booking.com response mapped
 * in backend/src/services/hotels.ts carries no location field, so every live
 * hotel fell to the 0.7 default and the term was a flat 0.94 — a constant
 * multiplier, which cannot change a sort order. It was arithmetic that looked
 * like a feature.
 *
 * Reinstating it is a real option, not a closed door: Booking exposes a
 * distance-to-centre figure on some plans. That needs someone with the
 * RapidAPI key to confirm the field on a raw response, then mapping it through
 * `HotelResult`. Until the data exists, the term is better absent than
 * pretending.
 *
 * Sanity check (Rome demo, no review counts so no discount applies):
 *   Termini Plaza      3.9 / $72   → ≈ 62.8  (winner)
 *   Casa Trastevere    4.5 / $110  → ≈ 61.3
 *   Hotel Pantheon     4.2 / $95   → ≈ 58.5
 *   Roma Boutique      4.7 / $145  → ≈ 52.5
 *   Villa Borghese     4.4 / $130  → ≈ 48.7
 *
 * Note the demo winner moved: Termini Plaza used to lose on its 0.55 location
 * and now wins on price. That is the honest consequence of having no location
 * data — and it only affects the demo set, since real searches never had a
 * location signal to lose.
 */
export function hotelScore(
  h: {
    rating: number;
    pricePerNight: number;
    reviewCount?: number;
  },
  priorMeanRating?: number,
): number {
  // A price that cannot be a real rate scores 0 instead of being clamped up.
  //
  // This line used to read `Math.max(1, h.pricePerNight)`, which turned 0 and
  // -50 into 1 — making the price term 100, the largest value it can take, so
  // the worst possible data scored BEST. Measured through this function: a
  // $0/night row scored 40028.8 and a $3/night row 16415.7, against ~235 for a
  // legitimate hotel. Both sorted first, and first is the trip's hotel and the
  // headline total.
  //
  // Note the asymmetry this corrects. An over-priced row is self-punishing —
  // $3377.84/night scores 11.9, i.e. last — which is why the over-priced
  // direction never needed rescuing and the under-priced one did.
  if (!Number.isFinite(h.pricePerNight) || h.pricePerNight <= 0) return 0;

  const ratingTerm = Math.pow(effectiveRating(h, priorMeanRating), 2.8);
  const priceTerm = 100 / h.pricePerNight;
  const score = ratingTerm * priceTerm;

  // A non-finite rating would otherwise propagate NaN into the comparator.
  return Number.isFinite(score) ? score : 0;
}

/**
 * Whether a row must sort below every trusted row, whatever its score.
 *
 * A hard partition rather than a score penalty, because a penalty would have
 * to be larger than any possible score gap to be reliable and there is no such
 * number — legitimate scores here span three orders of magnitude.
 */
function isDemoted(h: { priceSuspect?: boolean; score: number }): boolean {
  return h.priceSuspect === true || !Number.isFinite(h.score) || h.score <= 0;
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
    pricePerNight: number;
    reviewCount?: number;
    priceSuspect?: boolean;
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
    .sort((a, b) => {
      // Rows the backend distrusts, and rows with an unrankable price, go
      // below everything else. This is what makes flagging rather than
      // deleting safe: a suspect row stays browsable and bookable, but it can
      // never be `hotels[0]`, so it can never be the auto-selected hotel or
      // reach the trip total.
      const aDemoted = isDemoted(a) ? 1 : 0;
      const bDemoted = isDemoted(b) ? 1 : 0;
      if (aDemoted !== bDemoted) return aDemoted - bDemoted;

      // Explicit comparison, not `b.score - a.score`. Subtraction returns NaN
      // for two equal infinities, and a comparator that returns NaN is
      // incoherent — the engine then falls back on input order, which is
      // exactly how an untrusted row could still surface first.
      if (a.score === b.score) return 0;
      return b.score > a.score ? 1 : -1;
    });
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
