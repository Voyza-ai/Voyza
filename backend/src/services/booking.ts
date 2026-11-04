import { env } from '../config/env';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';
import { getDuffel } from './duffel';
import { getIataCode, withRetry } from './flights';
import { insertBooking, updateBooking, type BookingRecord } from './bookingStore';

/**
 * In-app flight booking: Duffel Orders + Duffel Payments.
 *
 *   1. quote        — fresh offer request for the leg, pick the offer that is
 *                     the flight the card shows (same carrier + departure
 *                     time), re-read it, report any price change.
 *   2. startPayment — re-read the offer again (offers expire, prices move),
 *                     validate travellers against the offer's own
 *                     requirements, require the fare-rules checkbox, create a
 *                     Duffel Payments intent for the offer total. The browser
 *                     collects the card with Duffel's component; card numbers
 *                     never touch this server.
 *   3. confirm      — confirm the intent, check the money matches the offer,
 *                     create an instant order paid from balance. If the order
 *                     fails after the card was charged, refund the intent.
 *
 * SAFETY: booking runs only on a Duffel TEST token unless BOOKING_LIVE_ENABLED
 * is exactly "true". A live order is real money and a real ticket.
 */

// ── Types ───────────────────────────────────────────────────────────────

export type QuoteInput = {
  origin: string;
  destination: string;
  originAirport?: string;
  destinationAirport?: string;
  date: string;
  travelers: number;
  carrierCode?: string;
  operator?: string;
  departTime?: string;
  /** Party total the card showed, to report a price change against. */
  previousPrice?: number;
  previousCurrency?: string;
  /**
   * Per traveller, their age on the travel date when under 18 (null = adult).
   * Children and infants are priced by age (Duffel `{ age }` passengers), so a
   * mum booking for two kids gets child fares, not three adult seats.
   * Traveller 1 is always quoted as an adult — they are the one booking.
   */
  ages?: Array<number | null>;
};

/** Duffel offer passenger → 'adult' | 'child' | 'infant_without_seat'. Age-priced passengers come back with `age` and no `type`. */
export function passengerTypeOf(p: any): string {
  if (p?.type) return p.type;
  if (typeof p?.age === 'number') return p.age < 2 ? 'infant_without_seat' : p.age < 18 ? 'child' : 'adult';
  return 'adult';
}

/** What to send Duffel for each traveller. */
export function offerRequestPassengers(travelers: number, ages?: Array<number | null>) {
  return Array.from({ length: travelers }, (_, i) => {
    const age = i === 0 ? null : ages?.[i];
    return typeof age === 'number' && age >= 0 && age < 18 ? { age } : { type: 'adult' as const };
  });
}

/** Title is optional for the traveller; airlines still need one — derive it from the passport gender. */
export function effectiveTitle(p: { title?: string; gender?: string }): string {
  if (p.title) return p.title;
  return p.gender === 'f' ? 'ms' : 'mr';
}

export type FareCondition = {
  allowed: boolean;
  penaltyAmount: string | null;
  penaltyCurrency: string | null;
} | null;

export type BookingQuote = {
  offerId: string;
  expiresAt: string;
  liveMode: boolean;
  totalAmount: string;
  totalCurrency: string;
  baseAmount: string | null;
  taxAmount: string | null;
  match: 'exact' | 'carrier' | 'cheapest';
  priceChange: null | {
    previous: number;
    current: number;
    currency: string;
    difference: number;
  };
  airline: { name: string; iataCode: string | null; conditionsOfCarriageUrl: string | null; logoUrl: string | null };
  slices: Array<{
    origin: string;
    originName: string;
    destination: string;
    destinationName: string;
    departingAt: string;
    arrivingAt: string;
    duration: string | null;
    fareBrandName: string | null;
    segments: Array<{
      flightNumber: string;
      carrier: string;
      origin: string;
      destination: string;
      departingAt: string;
      arrivingAt: string;
      aircraft: string | null;
      cabinClass: string | null;
      baggages: Array<{ type: string; quantity: number }>;
    }>;
  }>;
  passengers: Array<{ id: string; type: string; age: number | null }>;
  requirements: {
    identityDocumentsRequired: boolean;
    supportedDocumentTypes: string[];
    requiresInstantPayment: boolean;
  };
  conditions: {
    refundBeforeDeparture: FareCondition;
    changeBeforeDeparture: FareCondition;
  };
};

export type PassengerInput = {
  /** Optional — empty means "derive from gender" (effectiveTitle). */
  title: '' | 'mr' | 'ms' | 'mrs' | 'miss' | 'dr';
  given_name: string;
  family_name: string;
  gender: 'm' | 'f';
  born_on: string;
  passport?: {
    number: string;
    issuing_country_code: string;
    expires_on: string;
  } | null;
};

export type ContactInput = { email: string; phone_number: string };

// ── Safety ──────────────────────────────────────────────────────────────

export function bookingMode(): 'test' | 'live' {
  const token = env.DUFFEL_ACCESS_TOKEN ?? '';
  return token.startsWith('duffel_test_') ? 'test' : 'live';
}

/** Throws unless booking may run with the configured token. */
export function assertBookingAllowed(): void {
  const token = env.DUFFEL_ACCESS_TOKEN ?? '';
  if (!token) throw new AppError(503, 'Booking is not configured (no Duffel token).');
  if (bookingMode() === 'live' && env.BOOKING_LIVE_ENABLED !== true) {
    throw new AppError(
      503,
      'In-app booking is disabled on a live Duffel token. Set BOOKING_LIVE_ENABLED=true only once live booking is approved.',
    );
  }
}

function assertOfferMode(offer: any) {
  if (offer?.live_mode === true && env.BOOKING_LIVE_ENABLED !== true) {
    throw new AppError(503, 'Refusing to book a live-mode offer while live booking is disabled.');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

const IATA = /^[A-Za-z]{3}$/;

async function resolveAirport(code: string | undefined, name: string, tripCityNames: string[]) {
  if (code && IATA.test(code)) return code.toUpperCase();
  if (IATA.test(name)) return name.toUpperCase();
  return getIataCode(name, { tripDestinationNames: tripCityNames });
}

const hhmm = (iso: string | null | undefined) => {
  const m = /T(\d{2}:\d{2})/.exec(iso ?? '');
  return m ? m[1] : null;
};

function offerCarrierCodes(offer: any): string[] {
  const seg = offer?.slices?.[0]?.segments?.[0];
  return [offer?.owner?.iata_code, seg?.operating_carrier?.iata_code, seg?.marketing_carrier?.iata_code]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map((c) => c.toUpperCase());
}

function offerCarrierNames(offer: any): string[] {
  const seg = offer?.slices?.[0]?.segments?.[0];
  return [offer?.owner?.name, seg?.operating_carrier?.name, seg?.marketing_carrier?.name]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map((c) => c.toLowerCase());
}

/**
 * The offer that is the flight the card shows: same carrier AND departure
 * time first; then same carrier; then the cheapest. Duffel offer ids from the
 * original search are not stored on trips (and would have expired anyway).
 */
export function pickMatchingOffer(
  offers: any[],
  want: { carrierCode?: string; operator?: string; departTime?: string },
): { offer: any; match: BookingQuote['match'] } | null {
  const bookable = offers.filter((o) => !o.partial && o.total_amount);
  if (bookable.length === 0) return null;
  const byPrice = [...bookable].sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount));
  const code = want.carrierCode?.trim().toUpperCase();
  const op = want.operator?.trim().toLowerCase();
  const sameCarrier = (o: any) =>
    (code && code.length === 2 && offerCarrierCodes(o).includes(code)) ||
    (op && offerCarrierNames(o).includes(op));
  const sameTime = (o: any) =>
    !!want.departTime && hhmm(o?.slices?.[0]?.segments?.[0]?.departing_at) === want.departTime;

  const exact = byPrice.find((o) => sameCarrier(o) && sameTime(o));
  if (exact) return { offer: exact, match: 'exact' };
  const carrier = byPrice.find((o) => sameCarrier(o));
  if (carrier) return { offer: carrier, match: 'carrier' };
  return { offer: byPrice[0], match: 'cheapest' };
}

function condition(c: any): FareCondition {
  if (!c) return null;
  return {
    allowed: Boolean(c.allowed),
    penaltyAmount: c.penalty_amount ?? null,
    penaltyCurrency: c.penalty_currency ?? null,
  };
}

export function summarizeOffer(
  offer: any,
  match: BookingQuote['match'],
  previous?: { price?: number; currency?: string },
): BookingQuote {
  const current = parseFloat(offer.total_amount);
  const currency = offer.total_currency;
  let priceChange: BookingQuote['priceChange'] = null;
  if (
    typeof previous?.price === 'number' &&
    previous.price > 0 &&
    (previous.currency ?? 'USD') === currency &&
    Math.abs(current - previous.price) >= 0.5
  ) {
    priceChange = {
      previous: previous.price,
      current,
      currency,
      difference: Math.round((current - previous.price) * 100) / 100,
    };
  }
  return {
    offerId: offer.id,
    expiresAt: offer.expires_at,
    liveMode: Boolean(offer.live_mode),
    totalAmount: offer.total_amount,
    totalCurrency: currency,
    baseAmount: offer.base_amount ?? null,
    taxAmount: offer.tax_amount ?? null,
    match,
    priceChange,
    airline: {
      name: offer.owner?.name ?? 'Airline',
      iataCode: offer.owner?.iata_code ?? null,
      conditionsOfCarriageUrl: offer.owner?.conditions_of_carriage_url ?? null,
      logoUrl: offer.owner?.logo_symbol_url ?? null,
    },
    slices: (offer.slices ?? []).map((s: any) => ({
      origin: s.origin?.iata_code ?? '',
      originName: s.origin?.city_name ?? s.origin?.name ?? '',
      destination: s.destination?.iata_code ?? '',
      destinationName: s.destination?.city_name ?? s.destination?.name ?? '',
      departingAt: s.segments?.[0]?.departing_at ?? '',
      arrivingAt: s.segments?.[s.segments.length - 1]?.arriving_at ?? '',
      duration: s.duration ?? null,
      fareBrandName: s.fare_brand_name ?? null,
      segments: (s.segments ?? []).map((g: any) => ({
        flightNumber: `${g.marketing_carrier?.iata_code ?? ''}${g.marketing_carrier_flight_number ?? ''}`,
        carrier: g.operating_carrier?.name ?? g.marketing_carrier?.name ?? '',
        origin: g.origin?.iata_code ?? '',
        destination: g.destination?.iata_code ?? '',
        departingAt: g.departing_at ?? '',
        arrivingAt: g.arriving_at ?? '',
        aircraft: g.aircraft?.name ?? null,
        cabinClass: g.passengers?.[0]?.cabin_class_marketing_name ?? g.passengers?.[0]?.cabin_class ?? null,
        baggages: (g.passengers?.[0]?.baggages ?? []).map((b: any) => ({
          type: b.type,
          quantity: Number(b.quantity ?? 0),
        })),
      })),
    })),
    passengers: (offer.passengers ?? []).map((p: any) => ({
      id: p.id,
      type: passengerTypeOf(p),
      age: typeof p.age === 'number' ? p.age : null,
    })),
    requirements: {
      identityDocumentsRequired: Boolean(offer.passenger_identity_documents_required),
      supportedDocumentTypes: offer.supported_passenger_identity_document_types ?? [],
      requiresInstantPayment: Boolean(offer.payment_requirements?.requires_instant_payment ?? true),
    },
    conditions: {
      refundBeforeDeparture: condition(offer.conditions?.refund_before_departure),
      changeBeforeDeparture: condition(offer.conditions?.change_before_departure),
    },
  };
}

// ── Validation ──────────────────────────────────────────────────────────

const NAME = /^[A-Za-z][A-Za-z' -]{0,59}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const PASSPORT = /^[A-Za-z0-9]{5,20}$/;

function ageOn(bornOn: string, on: string): number {
  const [by, bm, bd] = bornOn.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/**
 * Field errors keyed `passengers.<i>.<field>` / `contact.<field>`. Driven by
 * the offer: passport only when the airline requires identity documents (or
 * accepts one and the traveller gave it), adult age rules by passenger type.
 */
export function validatePassengers(
  offer: any,
  passengers: PassengerInput[],
  contact: ContactInput,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const offerPassengers: any[] = offer?.passengers ?? [];
  const departDate = String(offer?.slices?.[0]?.segments?.[0]?.departing_at ?? '').slice(0, 10);
  const lastDate = String(
    offer?.slices?.[offer.slices.length - 1]?.segments?.slice(-1)?.[0]?.arriving_at ?? departDate,
  ).slice(0, 10);
  const docsRequired = Boolean(offer?.passenger_identity_documents_required);
  const passportSupported = (offer?.supported_passenger_identity_document_types ?? []).includes('passport');
  const today = new Date().toISOString().slice(0, 10);

  if (!Array.isArray(passengers) || passengers.length !== offerPassengers.length) {
    errors.passengers = `This fare is for ${offerPassengers.length} traveller${offerPassengers.length === 1 ? '' : 's'}.`;
    return errors;
  }

  passengers.forEach((p, i) => {
    const k = (f: string) => `passengers.${i}.${f}`;
    if (p?.title && !['mr', 'ms', 'mrs', 'miss', 'dr'].includes(p.title)) errors[k('title')] = 'Choose a title.';
    if (!NAME.test(p?.given_name ?? '')) errors[k('given_name')] = 'First name as on the passport (Latin letters).';
    if (!NAME.test(p?.family_name ?? '')) errors[k('family_name')] = 'Last name as on the passport (Latin letters).';
    if (!['m', 'f'].includes(p?.gender as string)) errors[k('gender')] = 'Choose the gender on the passport.';
    if (!DATE.test(p?.born_on ?? '') || p.born_on >= today) {
      errors[k('born_on')] = 'Enter a valid date of birth.';
    } else {
      const offerPax = offerPassengers[i];
      const type = passengerTypeOf(offerPax);
      const age = ageOn(p.born_on, departDate || today);
      if (age > 120) errors[k('born_on')] = 'Enter a valid date of birth.';
      else if (i === 0 && age < 18)
        errors[k('born_on')] = 'The first traveller must be 18 or over on the travel date — they are the one booking.';
      else if (type === 'adult' && age < 18)
        // Priced as an adult seat: the fare has to be re-quoted with this age first.
        errors[k('born_on')] = 'This traveller is under 18 — go back a step so we can price a child fare.';
      else if (type !== 'adult' && typeof offerPax?.age === 'number' && age !== offerPax.age)
        errors[k('born_on')] = 'This date of birth does not match the age the fare was priced for — go back a step.';
    }

    const pp = p?.passport;
    const gave = !!(pp && (pp.number || pp.issuing_country_code || pp.expires_on));
    if (docsRequired && !gave) {
      errors[k('passport')] = 'This airline requires passport details.';
    } else if (gave && (docsRequired || passportSupported)) {
      if (!PASSPORT.test(pp!.number ?? '')) errors[k('passport.number')] = 'Enter the passport number.';
      if (!/^[A-Za-z]{2}$/.test(pp!.issuing_country_code ?? ''))
        errors[k('passport.issuing_country_code')] = 'Two-letter country code, e.g. US.';
      if (!DATE.test(pp!.expires_on ?? '') || pp!.expires_on <= (lastDate || today))
        errors[k('passport.expires_on')] = 'The passport must be valid beyond the travel dates.';
    }
  });

  if (!EMAIL.test(contact?.email ?? '')) errors['contact.email'] = 'Enter a valid email.';
  if (!PHONE.test((contact?.phone_number ?? '').replace(/[\s()-]/g, '')))
    errors['contact.phone_number'] = 'Phone in international format, e.g. +14155550123.';
  return errors;
}

function toOrderPassengers(offer: any, passengers: PassengerInput[], contact: ContactInput) {
  const docsRequired = Boolean(offer?.passenger_identity_documents_required);
  const passportSupported = (offer?.supported_passenger_identity_document_types ?? []).includes('passport');
  return passengers.map((p, i) => {
    const pp = p.passport;
    const includeDoc = pp && pp.number && (docsRequired || passportSupported);
    return {
      id: offer.passengers[i].id,
      title: effectiveTitle(p),
      gender: p.gender,
      given_name: p.given_name.trim(),
      family_name: p.family_name.trim(),
      born_on: p.born_on,
      email: contact.email.trim(),
      phone_number: contact.phone_number.replace(/[\s()-]/g, ''),
      ...(includeDoc
        ? {
            identity_documents: [
              {
                type: 'passport' as const,
                unique_identifier: pp!.number.trim().toUpperCase(),
                issuing_country_code: pp!.issuing_country_code.trim().toUpperCase(),
                expires_on: pp!.expires_on,
              },
            ],
          }
        : {}),
    };
  });
}

// ── Duffel calls ────────────────────────────────────────────────────────

async function getOffer(offerId: string): Promise<any> {
  try {
    const res = await getDuffel().offers.get(offerId);
    return res.data;
  } catch (err: any) {
    const status = err?.meta?.status ?? err?.status;
    const code = err?.errors?.[0]?.code;
    logger.warn('booking: offer re-fetch failed', { offerId, status, code });
    if (status === 404 || code === 'offer_no_longer_available' || code === 'not_found') {
      throw new AppError(410, 'This fare is no longer available. Search again for a fresh price.', {
        reason: 'offer_expired',
      });
    }
    throw new AppError(502, 'Could not reach the airline to confirm this fare. Try again in a moment.');
  }
}

function assertNotExpired(offer: any) {
  if (offer?.expires_at && Date.parse(offer.expires_at) <= Date.now()) {
    throw new AppError(410, 'This fare has expired. Search again for a fresh price.', {
      reason: 'offer_expired',
    });
  }
}

export async function quoteFlight(input: QuoteInput): Promise<BookingQuote> {
  assertBookingAllowed();
  const tripNames = [input.origin, input.destination];
  const [origin, destination] = await Promise.all([
    resolveAirport(input.originAirport, input.origin, tripNames),
    resolveAirport(input.destinationAirport, input.destination, tripNames),
  ]);

  let offers: any[] = [];
  try {
    const req = await withRetry(() => getDuffel().offerRequests.create({
      slices: [{ origin, destination, departure_date: input.date } as any],
      passengers: offerRequestPassengers(input.travelers, input.ages),
      cabin_class: 'economy',
      return_offers: true,
    } as any));
    offers = ((req as any).data as any).offers ?? [];
  } catch (err: any) {
    logger.warn('booking: quote search failed', {
      origin,
      destination,
      message: err?.message,
      status: err?.meta?.status ?? err?.status,
      code: err?.errors?.[0]?.code,
      name: err?.name,
      detail: String(err?.errors?.[0]?.message ?? err ?? '').slice(0, 200),
    });
    throw new AppError(502, 'Could not search this flight right now. Try again in a moment.');
  }

  const picked = pickMatchingOffer(offers, input);
  if (!picked) {
    throw new AppError(404, 'No bookable fares found for this flight any more.', { reason: 'no_offers' });
  }
  const offer = await getOffer(picked.offer.id);
  assertOfferMode(offer);
  return summarizeOffer(offer, picked.match, {
    price: input.previousPrice,
    currency: input.previousCurrency ?? 'USD',
  });
}

// ── Pending payments ────────────────────────────────────────────────────
// Passenger details live here (in memory) only between "Pay" and the order:
// a few minutes. They are never written to the database.

type Pending = {
  userId: string;
  userEmail: string | null;
  tripId: string | null;
  offerId: string;
  amount: string;
  currency: string;
  passengers: PassengerInput[];
  contact: ContactInput;
  createdAt: number;
  done?: boolean;
  inFlight?: boolean;
};

const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 60 * 60 * 1000;

export function __resetPending() {
  pending.clear();
}

function prunePending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

export type StartPaymentInput = {
  userId: string;
  userEmail: string | null;
  tripId?: string | null;
  offerId: string;
  /** The amount the traveller agreed to on screen. */
  expectedAmount: string;
  expectedCurrency: string;
  passengers: PassengerInput[];
  contact: ContactInput;
  termsAccepted: boolean;
};

export async function startPayment(input: StartPaymentInput) {
  assertBookingAllowed();
  if (input.termsAccepted !== true) {
    throw new AppError(400, "Please accept the airline's fare rules and conditions to continue.", {
      reason: 'terms_not_accepted',
    });
  }

  const offer = await getOffer(input.offerId);
  assertOfferMode(offer);
  assertNotExpired(offer);

  // Price moved since the traveller looked: stop before charging and show it.
  if (
    offer.total_currency !== input.expectedCurrency ||
    Math.abs(parseFloat(offer.total_amount) - parseFloat(input.expectedAmount)) >= 0.01
  ) {
    throw new AppError(409, 'The price of this fare changed. Please review the new price.', {
      reason: 'price_changed',
      quote: summarizeOffer(offer, 'exact', {
        price: parseFloat(input.expectedAmount),
        currency: input.expectedCurrency,
      }),
    });
  }

  const fieldErrors = validatePassengers(offer, input.passengers, input.contact);
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError(400, 'Some traveller details need fixing.', { reason: 'invalid_passengers', fieldErrors });
  }

  let intent: any;
  try {
    const res = await getDuffel().paymentIntents.create({
      amount: offer.total_amount,
      currency: offer.total_currency,
    });
    intent = res.data;
  } catch (err: any) {
    logger.warn('booking: payment intent create failed', {
      message: err?.message,
      code: err?.errors?.[0]?.code,
    });
    throw new AppError(502, 'Could not start the payment. Nothing was charged — try again.');
  }

  prunePending();
  pending.set(intent.id, {
    userId: input.userId,
    userEmail: input.userEmail,
    tripId: input.tripId ?? null,
    offerId: offer.id,
    amount: offer.total_amount,
    currency: offer.total_currency,
    passengers: input.passengers,
    contact: input.contact,
    createdAt: Date.now(),
  });

  await insertBooking(baseRecord(input.userId, input.tripId ?? null, offer, intent.id, input.passengers));

  return {
    paymentIntentId: intent.id as string,
    clientToken: intent.client_token as string,
    amount: offer.total_amount as string,
    currency: offer.total_currency as string,
    liveMode: Boolean(intent.live_mode),
  };
}

function baseRecord(
  userId: string,
  tripId: string | null,
  offer: any,
  paymentIntentId: string,
  passengers: PassengerInput[],
): BookingRecord {
  return {
    user_id: userId,
    trip_id: tripId,
    duffel_offer_id: offer.id,
    duffel_payment_intent_id: paymentIntentId,
    duffel_order_id: null,
    booking_reference: null,
    status: 'payment_pending',
    total_amount: parseFloat(offer.total_amount),
    total_currency: offer.total_currency,
    passengers: passengers.map((p, i) => ({
      given_name: p.given_name,
      family_name: p.family_name,
      type: passengerTypeOf(offer.passengers?.[i]),
    })),
    slices: (offer.slices ?? []).map((s: any) => ({
      origin: s.origin?.iata_code,
      destination: s.destination?.iata_code,
      departing_at: s.segments?.[0]?.departing_at,
      arriving_at: s.segments?.[s.segments.length - 1]?.arriving_at,
      carrier: offer.owner?.name,
    })),
    live_mode: Boolean(offer.live_mode),
    failure_reason: null,
  };
}

async function refundIntent(paymentIntentId: string, amount: string, currency: string): Promise<boolean> {
  try {
    await getDuffel().refunds.create({ payment_intent_id: paymentIntentId, amount, currency } as any);
    return true;
  } catch (err: any) {
    logger.error('booking: REFUND FAILED — manual refund needed', {
      paymentIntentId,
      message: err?.message,
      code: err?.errors?.[0]?.code,
    });
    return false;
  }
}

export type ConfirmedBooking = {
  orderId: string;
  bookingReference: string;
  status: 'confirmed';
  totalAmount: string;
  totalCurrency: string;
  order: any;
  userEmail: string | null;
  tripId: string | null;
};

/**
 * Card collected → confirm the intent → create the order. Every failure
 * after money moved ends in a refund attempt and a `failed` / `refunded`
 * booking row, never in a silent charge.
 */
export async function confirmBooking(userId: string, paymentIntentId: string): Promise<ConfirmedBooking> {
  assertBookingAllowed();
  const p = pending.get(paymentIntentId);
  if (!p || p.userId !== userId) {
    throw new AppError(404, 'This payment session has expired. Nothing was booked — please start again.', {
      reason: 'unknown_payment',
    });
  }
  if (p.done) throw new AppError(409, 'This booking was already completed.', { reason: 'already_done' });
  // A double-click / retry while the first confirm is still talking to the
  // airline must not create a second order for one payment.
  if (p.inFlight) throw new AppError(409, 'This booking is already being confirmed.', { reason: 'in_progress' });
  p.inFlight = true;
  try {
    return await confirmPending(userId, paymentIntentId, p);
  } finally {
    p.inFlight = false;
  }
}

async function confirmPending(userId: string, paymentIntentId: string, p: Pending): Promise<ConfirmedBooking> {
  let intent: any;
  try {
    intent = (await getDuffel().paymentIntents.confirm(paymentIntentId)).data;
  } catch (err: any) {
    logger.warn('booking: payment confirm failed', { paymentIntentId, code: err?.errors?.[0]?.code });
    await updateBooking(paymentIntentId, { status: 'failed', failure_reason: 'payment_confirm_failed' });
    throw new AppError(402, 'The card payment did not go through. You have not been charged.', {
      reason: 'payment_failed',
    });
  }
  if (intent?.status !== 'succeeded') {
    await updateBooking(paymentIntentId, { status: 'failed', failure_reason: `payment_${intent?.status}` });
    throw new AppError(402, 'The card payment did not go through. You have not been charged.', {
      reason: 'payment_failed',
    });
  }
  if (intent.amount !== p.amount || intent.currency !== p.currency) {
    const refunded = await refundIntent(paymentIntentId, intent.amount, intent.currency);
    await updateBooking(paymentIntentId, {
      status: refunded ? 'refunded' : 'failed',
      failure_reason: 'amount_mismatch',
    });
    throw new AppError(409, 'The payment amount did not match the fare. Your payment is being refunded.', {
      reason: 'amount_mismatch',
    });
  }

  // Money is in the balance. Last check that the fare is still the same.
  let offer: any;
  try {
    offer = await getOffer(p.offerId);
    assertNotExpired(offer);
  } catch (err) {
    const refunded = await refundIntent(paymentIntentId, p.amount, p.currency);
    await updateBooking(paymentIntentId, { status: refunded ? 'refunded' : 'failed', failure_reason: 'offer_expired' });
    throw new AppError(410, 'The fare expired before it could be booked. Your payment is being refunded.', {
      reason: 'offer_expired',
      refunded,
    });
  }
  if (offer.total_amount !== p.amount || offer.total_currency !== p.currency) {
    const refunded = await refundIntent(paymentIntentId, p.amount, p.currency);
    await updateBooking(paymentIntentId, { status: refunded ? 'refunded' : 'failed', failure_reason: 'price_changed' });
    throw new AppError(409, 'The airline changed the price before booking. Your payment is being refunded.', {
      reason: 'price_changed',
      refunded,
    });
  }

  let order: any;
  try {
    const res = await getDuffel().orders.create({
      type: 'instant',
      selected_offers: [offer.id],
      passengers: toOrderPassengers(offer, p.passengers, p.contact) as any,
      payments: [{ type: 'balance', amount: offer.total_amount, currency: offer.total_currency }],
      metadata: { bluemurr_user: userId.slice(0, 36), ...(p.tripId ? { trip_id: p.tripId } : {}) },
    } as any);
    order = res.data;
  } catch (err: any) {
    const code = err?.errors?.[0]?.code;
    const detail = err?.errors?.[0]?.message;
    logger.warn('booking: order create failed', { paymentIntentId, code, detail });
    const refunded = await refundIntent(paymentIntentId, p.amount, p.currency);
    await updateBooking(paymentIntentId, {
      status: refunded ? 'refunded' : 'failed',
      failure_reason: `order_failed:${code ?? 'unknown'}`,
    });
    throw new AppError(
      502,
      refunded
        ? 'The airline could not confirm this booking. Your payment has been refunded.'
        : 'The airline could not confirm this booking. We will refund your payment — contact support if you do not see it.',
      { reason: 'order_failed', code: code ?? null, refunded },
    );
  }

  p.done = true;
  await updateBooking(paymentIntentId, {
    status: 'confirmed',
    duffel_order_id: order.id,
    booking_reference: order.booking_reference ?? null,
  });

  return {
    orderId: order.id,
    bookingReference: order.booking_reference ?? '',
    status: 'confirmed',
    totalAmount: order.total_amount,
    totalCurrency: order.total_currency,
    order,
    userEmail: p.userEmail,
    tripId: p.tripId,
  };
}

export async function getOrder(orderId: string): Promise<any> {
  try {
    return (await getDuffel().orders.get(orderId)).data;
  } catch (err: any) {
    logger.warn('booking: order fetch failed', { orderId, message: err?.message });
    throw new AppError(502, 'Could not load this booking from the airline right now.');
  }
}
