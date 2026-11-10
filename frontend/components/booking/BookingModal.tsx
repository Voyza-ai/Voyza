'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Plane, ArrowRight, AlertTriangle, CheckCircle2, FileText, Loader2, Luggage } from 'lucide-react';
import {
  ApiError,
  confirmBooking,
  fetchItineraryPdf,
  getBookingQuote,
  startBookingPayment,
  type BookingConfirmation,
  type BookingContact,
  type BookingPassenger,
  type BookingQuote,
  type FareCondition,
} from '@/lib/api';
import type { Transport } from '@/lib/types';
import { useAuthStore } from '@/store/authStore';
import PassengerForm, { emptyPassenger, fareAges, validatePassengerForm, type PassengerErrors } from './PassengerForm';
// Card number · expiry · CVC · ZIP in separate Stripe fields; the card goes
// from Stripe's iframes to Duffel — never to our backend.
import CardPaymentForm from './CardPaymentForm';


const BLUE = '#2563eb';

type Step = 'quote' | 'travellers' | 'review' | 'pay' | 'confirming' | 'done';

type Props = {
  transport: Transport;
  /** Departure date of this leg (YYYY-MM-DD). */
  date: string;
  travelers: number;
  tripId?: string | null;
  onClose: () => void;
};

export const money = (amount: string | number, currency: string) => {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};

const localTime = (iso: string) => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '—';
const localDay = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};
const isoDuration = (iso: string | null) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso ?? '');
  if (!m) return '';
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0);
  return `${h ? `${h}h ` : ''}${m[3] ? `${Number(m[3])}m` : ''}`.trim();
};

export function describeCondition(label: string, c: FareCondition): string {
  if (!c) return `${label}: the airline hasn't said — check its fare rules`;
  if (!c.allowed) return `${label}: not allowed`;
  if (c.penaltyAmount && parseFloat(c.penaltyAmount) > 0)
    return `${label}: allowed, fee ${money(c.penaltyAmount, c.penaltyCurrency ?? 'USD')}`;
  return `${label}: allowed, no fee`;
}

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ['quote', 'travellers', 'review', 'pay'];
  const labels = ['Flight', 'Travellers', 'Fare rules', 'Payment'];
  const at = step === 'confirming' || step === 'done' ? 4 : order.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-[11px]">
      {labels.map((l, i) => (
        <li key={l} className="flex items-center gap-2">
          <span
            className="px-2 py-0.5 rounded-full"
            style={{
              background: i <= at ? `${BLUE}14` : 'transparent',
              color: i <= at ? BLUE : '#9ca3af',
              fontWeight: i === at ? 600 : 500,
            }}
          >
            {l}
          </span>
          {i < labels.length - 1 && <span className="text-gray-300">·</span>}
        </li>
      ))}
    </ol>
  );
}

function FlightSummary({ quote }: { quote: BookingQuote }) {
  return (
    <div className="flex flex-col gap-2">
      {quote.slices.map((s, si) => (
        <div key={si} className="rounded-xl p-4" style={{ background: '#f0f4f8' }}>
          <div className="flex items-center justify-between text-[11px] text-gray-500 mb-2">
            <span>
              {localDay(s.departingAt)} · {quote.airline.name}
              {s.fareBrandName ? ` · ${s.fareBrandName}` : ''}
            </span>
            <span>
              {isoDuration(s.duration)} · {s.segments.length === 1 ? 'Direct' : `${s.segments.length - 1} stop${s.segments.length > 2 ? 's' : ''}`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div>
              <div className="text-[20px] font-semibold font-mono tabular-nums text-gray-900">{localTime(s.departingAt)}</div>
              <div className="text-[12px] text-gray-600">
                {s.origin} · {s.originName}
              </div>
            </div>
            <div className="flex-1 flex items-center gap-1 px-2">
              <div className="flex-1 border-t border-dashed" style={{ borderColor: `${BLUE}80` }} />
              <Plane size={14} style={{ color: BLUE }} />
              <div className="flex-1 border-t border-dashed" style={{ borderColor: `${BLUE}80` }} />
            </div>
            <div className="text-right">
              <div className="text-[20px] font-semibold font-mono tabular-nums text-gray-900">{localTime(s.arrivingAt)}</div>
              <div className="text-[12px] text-gray-600">
                {s.destination} · {s.destinationName}
              </div>
            </div>
          </div>
          <div className="mt-2 text-[11px] text-gray-500 flex flex-wrap gap-x-3">
            {s.segments.map((g, gi) => (
              <span key={gi}>
                {g.flightNumber} {g.origin}→{g.destination}
                {g.cabinClass ? ` · ${g.cabinClass}` : ''}
              </span>
            ))}
            {s.segments[0]?.baggages?.length > 0 && (
              <span className="flex items-center gap-1">
                <Luggage size={11} />
                {s.segments[0].baggages.map((b) => `${b.quantity} ${b.type.replace('_', ' ')}`).join(', ')}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PriceBlock({ quote }: { quote: BookingQuote }) {
  return (
    <div className="flex items-end justify-between">
      <div className="text-[12px] text-gray-500">
        Total for {quote.passengers.length} traveller{quote.passengers.length === 1 ? '' : 's'}, taxes included
      </div>
      <div className="text-[22px] font-semibold tabular-nums text-gray-900" data-testid="booking-total">
        {money(quote.totalAmount, quote.totalCurrency)}
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  const c = tone === 'error' ? '#dc2626' : tone === 'warn' ? '#b45309' : BLUE;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="rounded-lg px-3 py-2 text-[12px] flex items-start gap-2"
      style={{ background: `${c}10`, color: c, border: `1px solid ${c}30` }}
    >
      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

export default function BookingModal({ transport: transportProp, date, travelers, tripId, onClose }: Props) {
  // Snapshot: parents rebuild the Transport object on every render, and the
  // quote must be fetched once per opening, not once per parent render.
  const [transport] = useState(transportProp);
  const userEmail = useAuthStore((s) => s.user?.email ?? '');
  const signedIn = useAuthStore((s) => Boolean(s.user));
  const [step, setStep] = useState<Step>('quote');
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [priceNotice, setPriceNotice] = useState<string | null>(null);
  const [passengers, setPassengers] = useState<BookingPassenger[]>([]);
  const [contact, setContact] = useState<BookingContact>({ email: userEmail, phone_number: '' });
  const [fieldErrors, setFieldErrors] = useState<PassengerErrors>({});
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState<{ paymentIntentId: string; clientToken: string } | null>(null);
  const [result, setResult] = useState<BookingConfirmation | null>(null);
  const confirmingRef = useRef(false);

  /** What to ask the airline for this leg; `ages` re-prices children. */
  const quoteParams = useCallback(
    (ages?: Array<number | null>) => {
      const airport = (s?: string) => (s && /^[A-Z]{3}$/.test(s) ? s : undefined);
      return {
        origin: transport.from ?? '',
        destination: transport.to ?? '',
        originAirport: airport(transport.fromStation),
        destinationAirport: airport(transport.toStation),
        date,
        travelers,
        carrierCode: transport.flightNumber && /^[A-Z0-9]{2}$/.test(transport.flightNumber) ? transport.flightNumber : undefined,
        operator: transport.operator || undefined,
        departTime: transport.departTime && /^\d{2}:\d{2}$/.test(transport.departTime) ? transport.departTime : undefined,
        previousPrice: transport.price > 0 ? transport.price : undefined,
        ...(ages ? { ages } : {}),
      };
    },
    [transport, date, travelers],
  );

  const applyQuote = useCallback((q: BookingQuote) => {
    setQuote(q);
    setPassengers((prev) =>
      prev.length === q.passengers.length
        ? prev.map((p) =>
            q.requirements.identityDocumentsRequired && !p.passport
              ? { ...p, passport: { number: '', issuing_country_code: '', expires_on: '' } }
              : p,
          )
        : q.passengers.map(() => emptyPassenger(q.requirements.identityDocumentsRequired)),
    );
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const { quote: q } = await getBookingQuote(quoteParams());
        if (cancelled) return;
        applyQuote(q);
        if (q.priceChange) {
          const up = q.priceChange.difference > 0;
          setPriceNotice(
            `The price ${up ? 'went up' : 'dropped'} since this trip was planned: ${money(q.priceChange.previous, q.priceChange.currency)} → ${money(q.priceChange.current, q.priceChange.currency)}.`,
          );
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load this fare.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, quoteParams, applyQuote]);

  const goReview = async () => {
    if (!quote) return;
    const errs = validatePassengerForm(quote, passengers, contact);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    // Children travel on child fares: when the ages entered differ from what
    // the fare was priced for, ask the airline again before showing the rules.
    const wanted = fareAges(quote, passengers);
    const priced = quote.passengers.map((p, i) => (i > 0 && typeof p.age === 'number' && p.age < 18 ? p.age : null));
    if (wanted.some((a, i) => a !== priced[i])) {
      setBusy(true);
      setError(null);
      try {
        const { quote: q } = await getBookingQuote(quoteParams(wanted));
        const kids = wanted.filter((a) => a !== null).length;
        if (q.totalAmount !== quote.totalAmount) {
          setPriceNotice(
            kids > 0
              ? `Priced with ${kids} child fare${kids === 1 ? '' : 's'}: ${money(quote.totalAmount, quote.totalCurrency)} → ${money(q.totalAmount, q.totalCurrency)}.`
              : `Priced for ${passengers.length} adult${passengers.length === 1 ? '' : 's'}: ${money(quote.totalAmount, quote.totalCurrency)} → ${money(q.totalAmount, q.totalCurrency)}.`,
          );
        }
        applyQuote(q);
        setTermsAccepted(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not price this fare for these travellers.');
        return;
      } finally {
        setBusy(false);
      }
    }
    setStep('review');
  };

  const startPayment = async () => {
    if (!quote || !termsAccepted) return;
    setBusy(true);
    setError(null);
    try {
      const res = await startBookingPayment({
        offerId: quote.offerId,
        expectedAmount: quote.totalAmount,
        expectedCurrency: quote.totalCurrency,
        passengers,
        contact,
        termsAccepted,
        tripId: tripId ?? null,
      });
      setPayment({ paymentIntentId: res.paymentIntentId, clientToken: res.clientToken });
      setStep('pay');
    } catch (e) {
      const details = (e as ApiError)?.details as any;
      if (details?.reason === 'price_changed' && details.quote) {
        const q = details.quote as BookingQuote;
        setPriceNotice(
          `The airline changed the price: ${money(quote.totalAmount, quote.totalCurrency)} → ${money(q.totalAmount, q.totalCurrency)}. Review and accept again to continue.`,
        );
        applyQuote(q);
        setTermsAccepted(false);
      } else if (details?.reason === 'invalid_passengers') {
        setFieldErrors(details.fieldErrors ?? {});
        setStep('travellers');
        setError('Some traveller details need fixing.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not start the payment.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onPaid = async () => {
    if (!payment || confirmingRef.current) return;
    confirmingRef.current = true;
    setStep('confirming');
    setError(null);
    try {
      const r = await confirmBooking(payment.paymentIntentId);
      setResult(r);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The booking could not be completed.');
      setStep('review');
      setPayment(null);
      setTermsAccepted(false);
    } finally {
      confirmingRef.current = false;
    }
  };

  const openPdf = async () => {
    if (!result) return;
    // Open the tab inside the click (popup blockers allow only that), then
    // point it at the PDF once the authenticated fetch lands.
    const tab = window.open('', '_blank');
    try {
      const blob = await fetchItineraryPdf(result.orderId);
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : 'Could not open the itinerary.');
    }
  };

  const primaryBtn =
    'h-10 px-5 rounded-full text-[13px] font-semibold text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.35)' }}
      onClick={step === 'confirming' ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Book this flight"
        onClick={(e) => e.stopPropagation()}
        className="w-[600px] max-h-[90vh] rounded-2xl bg-white border shadow-xl flex flex-col overflow-hidden"
        style={{ borderColor: 'rgba(0,0,0,0.08)' }}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-gray-900">
              {transport.from} <ArrowRight size={14} className="text-gray-400" /> {transport.to}
              {quote && !quote.liveMode && (
                <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: '#fef3c7', color: '#92400e' }}>
                  TEST MODE
                </span>
              )}
            </div>
            <StepDots step={step} />
          </div>
          {step !== 'confirming' && (
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-800">
              <X size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          {!signedIn && <Banner tone="info">Sign in to book this flight.</Banner>}
          {error && <Banner tone="error">{error}</Banner>}
          {priceNotice && step !== 'done' && <Banner tone="warn">{priceNotice}</Banner>}

          {signedIn && !quote && !error && (
            <div className="py-10 flex flex-col items-center gap-2 text-[13px] text-gray-500">
              <Loader2 size={18} className="animate-spin" style={{ color: BLUE }} />
              Checking the latest fare with the airline…
            </div>
          )}

          {quote && step === 'quote' && (
            <>
              {quote.match !== 'exact' && (
                <Banner tone="warn">
                  {quote.match === 'carrier'
                    ? `That exact departure is no longer on sale — this is the closest ${quote.airline.name} flight.`
                    : 'That flight is no longer on sale — this is the cheapest available flight on the route.'}
                </Banner>
              )}
              <FlightSummary quote={quote} />
              <PriceBlock quote={quote} />
            </>
          )}

          {quote && step === 'travellers' && (
            <PassengerForm
              quote={quote}
              passengers={passengers}
              contact={contact}
              errors={fieldErrors}
              onChange={(p, c) => {
                setPassengers(p);
                setContact(c);
              }}
            />
          )}

          {quote && step === 'review' && (
            <>
              <FlightSummary quote={quote} />
              <div className="rounded-xl border p-4 flex flex-col gap-2" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
                <div className="text-[13px] font-semibold text-gray-900">Fare rules — {quote.airline.name}</div>
                <ul className="text-[12px] text-gray-700 flex flex-col gap-1 list-disc pl-4">
                  <li>{describeCondition('Refund before departure', quote.conditions.refundBeforeDeparture)}</li>
                  <li>{describeCondition('Change before departure', quote.conditions.changeBeforeDeparture)}</li>
                  <li>Names must match each passport exactly; tickets are non-transferable.</li>
                  <li>
                    This price is held until{' '}
                    {new Date(quote.expiresAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.
                  </li>
                </ul>
                {quote.airline.conditionsOfCarriageUrl ? (
                  <a
                    href={quote.airline.conditionsOfCarriageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] font-medium underline"
                    style={{ color: BLUE }}
                  >
                    {quote.airline.name} conditions of carriage
                  </a>
                ) : (
                  <span className="text-[12px] text-gray-500">The airline publishes no conditions-of-carriage link for this fare.</span>
                )}
                <label className="mt-2 flex items-start gap-2 text-[12px] text-gray-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="mt-0.5"
                    style={{ accentColor: BLUE }}
                  />
                  <span>
                    I have read and accept {quote.airline.name}&apos;s fare rules and conditions of carriage for this
                    booking.
                  </span>
                </label>
              </div>
              <PriceBlock quote={quote} />
            </>
          )}

          {quote && step === 'pay' && payment && (
            <>
              <PriceBlock quote={quote} />
              <div className="rounded-xl border p-3" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
                <CardPaymentForm
                  clientToken={payment.clientToken}
                  payLabel={`Pay ${money(quote.totalAmount, quote.totalCurrency)}`}
                  onPaid={() => {
                    setError(null);
                    void onPaid();
                  }}
                  onFailed={(message) => setError(message)}
                />
              </div>
              <p className="text-[11px] text-gray-500">
                Card details go directly to our payment provider, Duffel. BlueMurr never sees your card number.
                {!quote.liveMode && ' Test mode: use card 4242 4242 4242 4242, any future expiry, any CVC.'}
              </p>
            </>
          )}

          {step === 'confirming' && (
            <div className="py-10 flex flex-col items-center gap-2 text-[13px] text-gray-600">
              <Loader2 size={20} className="animate-spin" style={{ color: BLUE }} />
              Payment received — confirming your seats with {quote?.airline.name ?? 'the airline'}…
            </div>
          )}

          {step === 'done' && result && (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <CheckCircle2 size={36} style={{ color: '#16a34a' }} />
              <div className="text-[16px] font-semibold text-gray-900">Your flight is booked</div>
              <div className="text-[12px] text-gray-500">Booking reference</div>
              <div className="text-[26px] font-mono font-bold tracking-widest" style={{ color: BLUE }} data-testid="booking-reference">
                {result.bookingReference}
              </div>
              <div className="text-[12px] text-gray-600">
                {money(result.totalAmount, result.totalCurrency)} paid · order {result.orderId}
              </div>
              <div className="text-[12px] text-gray-600">
                {result.emailSent
                  ? `Confirmation and itinerary sent to ${result.emailTo}.`
                  : 'We could not send the confirmation email — download your itinerary below.'}
              </div>
              <button onClick={openPdf} className={primaryBtn} style={{ background: BLUE }}>
                <FileText size={14} /> View itinerary (PDF)
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {quote && ['quote', 'travellers', 'review'].includes(step) && (
          <div className="px-5 py-3 border-t flex items-center justify-between" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
            <button
              onClick={() => (step === 'quote' ? onClose() : setStep(step === 'review' ? 'travellers' : 'quote'))}
              className="text-[13px] text-gray-600 hover:text-gray-900"
            >
              {step === 'quote' ? 'Cancel' : 'Back'}
            </button>
            {step === 'quote' && (
              <button onClick={() => setStep('travellers')} className={primaryBtn} style={{ background: BLUE }}>
                Continue
              </button>
            )}
            {step === 'travellers' && (
              <button onClick={() => void goReview()} disabled={busy} className={primaryBtn} style={{ background: BLUE }}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                {busy ? 'Pricing for your travellers…' : 'Continue'}
              </button>
            )}
            {step === 'review' && (
              <button onClick={startPayment} disabled={!termsAccepted || busy} className={primaryBtn} style={{ background: BLUE }}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                Continue to payment · {money(quote.totalAmount, quote.totalCurrency)}
              </button>
            )}
          </div>
        )}
        {step === 'done' && (
          <div className="px-5 py-3 border-t flex justify-end" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
            <button onClick={onClose} className="text-[13px] text-gray-600 hover:text-gray-900">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
