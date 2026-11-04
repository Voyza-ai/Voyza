'use client';

/**
 * Card number · Expiry · CVC · ZIP as four separate fields on one line.
 *
 * Duffel's own <DuffelPayments> renders Stripe's single combined CardElement.
 * This is the same flow with Stripe's split elements: the Duffel payment-intent
 * client token is base64 JSON { publishable_key, client_secret } (exactly what
 * @duffel/components decodes), and the card is confirmed against that intent
 * with `stripe.confirmCardPayment`. Card data stays inside Stripe's iframes and
 * goes to Duffel's Stripe account — never to our backend.
 */
import { useMemo, useState } from 'react';
import { loadStripe, type StripeCardNumberElement, type StripeElementStyle } from '@stripe/stripe-js';
import {
  CardCvcElement,
  CardExpiryElement,
  CardNumberElement,
  Elements,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { Loader2, Lock } from 'lucide-react';

const BLUE = '#2563eb';

const ELEMENT_STYLE: StripeElementStyle = {
  base: {
    fontSize: '13px',
    color: '#111827',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    '::placeholder': { color: '#9ca3af' },
  },
  invalid: { color: '#dc2626' },
};

type Field = 'number' | 'expiry' | 'cvc';

function decodeToken(token: string): { publishable_key: string; client_secret: string } | null {
  try {
    const t = JSON.parse(atob(token));
    return t?.publishable_key && t?.client_secret ? t : null;
  } catch {
    return null;
  }
}

function FieldBox({
  label,
  htmlFor,
  focused,
  invalid,
  children,
}: {
  label: string;
  htmlFor?: string;
  focused: boolean;
  invalid: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label htmlFor={htmlFor} className="text-[11px] font-medium text-gray-600">
        {label}
      </label>
      <div
        className="h-9 px-3 rounded-lg border bg-white flex items-center"
        style={{ borderColor: invalid ? '#dc2626' : focused ? BLUE : 'rgba(0,0,0,0.12)' }}
      >
        <div className="w-full">{children}</div>
      </div>
    </div>
  );
}

function Form({
  clientSecret,
  payLabel,
  onPaid,
  onFailed,
}: {
  clientSecret: string;
  payLabel: string;
  onPaid: () => void;
  onFailed: (message: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [complete, setComplete] = useState<Record<Field, boolean>>({ number: false, expiry: false, cvc: false });
  const [fieldError, setFieldError] = useState<Partial<Record<Field, string>>>({});
  const [focus, setFocus] = useState<Field | 'zip' | null>(null);
  const [zip, setZip] = useState('');
  const [busy, setBusy] = useState(false);

  const track = (f: Field) => ({
    onChange: (e: { complete: boolean; error?: { message: string } }) => {
      setComplete((c) => ({ ...c, [f]: e.complete }));
      setFieldError((x) => ({ ...x, [f]: e.error?.message }));
    },
    onFocus: () => setFocus(f),
    onBlur: () => setFocus(null),
  });

  const zipOk = zip.trim().length >= 3;
  const ready = !!stripe && !!elements && complete.number && complete.expiry && complete.cvc && zipOk;
  const firstError = fieldError.number ?? fieldError.expiry ?? fieldError.cvc;

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy || !stripe || !elements) return;
    const card = elements.getElement(CardNumberElement) as StripeCardNumberElement | null;
    if (!card) return;
    setBusy(true);
    const result = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card, billing_details: { address: { postal_code: zip.trim() } } },
    });
    setBusy(false);
    if (result.error) onFailed(result.error.message ?? 'The card was declined. Try another card.');
    else onPaid();
  };

  return (
    <form onSubmit={pay} className="flex flex-col gap-3" data-testid="card-form">
      <div className="grid grid-cols-[2.2fr_1fr_0.8fr_1fr] gap-2">
        <FieldBox label="Card number" focused={focus === 'number'} invalid={!!fieldError.number}>
          <CardNumberElement options={{ style: ELEMENT_STYLE, showIcon: true, placeholder: '1234 1234 1234 1234' }} {...track('number')} />
        </FieldBox>
        <FieldBox label="Expiry" focused={focus === 'expiry'} invalid={!!fieldError.expiry}>
          <CardExpiryElement options={{ style: ELEMENT_STYLE }} {...track('expiry')} />
        </FieldBox>
        <FieldBox label="CVC" focused={focus === 'cvc'} invalid={!!fieldError.cvc}>
          <CardCvcElement options={{ style: ELEMENT_STYLE }} {...track('cvc')} />
        </FieldBox>
        <FieldBox label="ZIP code" htmlFor="card-zip" focused={focus === 'zip'} invalid={false}>
          <input
            id="card-zip"
            value={zip}
            onChange={(e) => setZip(e.target.value.slice(0, 10))}
            onFocus={() => setFocus('zip')}
            onBlur={() => setFocus(null)}
            autoComplete="postal-code"
            inputMode="text"
            placeholder="10001"
            className="w-full text-[13px] text-gray-900 bg-transparent outline-none placeholder:text-gray-400"
          />
        </FieldBox>
      </div>
      {firstError && (
        <span role="alert" className="text-[11px] text-red-600">
          {firstError}
        </span>
      )}
      <button
        type="submit"
        disabled={!ready || busy}
        className="h-10 rounded-full text-[13px] font-semibold text-white flex items-center justify-center gap-2 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: BLUE }}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={13} />}
        {busy ? 'Processing…' : payLabel}
      </button>
    </form>
  );
}

export default function CardPaymentForm({
  clientToken,
  payLabel,
  onPaid,
  onFailed,
}: {
  /** Duffel payment-intent client token. */
  clientToken: string;
  payLabel: string;
  onPaid: () => void;
  onFailed: (message: string) => void;
}) {
  const token = useMemo(() => decodeToken(clientToken), [clientToken]);
  const stripePromise = useMemo(() => (token ? loadStripe(token.publishable_key) : null), [token]);
  if (!token || !stripePromise) {
    return <div className="text-[12px] text-red-600 py-4">The payment could not be started. Close this and try again.</div>;
  }
  return (
    <Elements stripe={stripePromise}>
      <Form clientSecret={token.client_secret} payLabel={payLabel} onPaid={onPaid} onFailed={onFailed} />
    </Elements>
  );
}
