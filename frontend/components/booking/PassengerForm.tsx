'use client';

import type { BookingContact, BookingPassenger, BookingQuote } from '@/lib/api';
import DateSelect from './DateSelect';

/**
 * Traveller details for one booking, shaped by the offer: one block per
 * passenger on the fare, passport fields only when the airline requires
 * identity documents (Duffel `passenger_identity_documents_required`), and
 * one shared contact block (Duffel needs an email + phone per passenger; we
 * send the same contact for each).
 */

export type PassengerErrors = Record<string, string>;

export function emptyPassenger(withPassport: boolean): BookingPassenger {
  return {
    title: '',
    given_name: '',
    family_name: '',
    gender: '',
    born_on: '',
    passport: withPassport ? { number: '', issuing_country_code: '', expires_on: '' } : null,
  };
}

/** Whole years old on `on` (both YYYY-MM-DD). */
export function ageOn(bornOn: string, on: string): number {
  const [by, bm, bd] = bornOn.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * The ages to price the fare with: null for an adult, the age for anyone
 * after traveller 1 who is under 18 on the travel date.
 */
export function fareAges(quote: Pick<BookingQuote, 'slices'>, passengers: BookingPassenger[]): Array<number | null> {
  const travelDate = quote.slices[0]?.departingAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return passengers.map((p, i) => {
    if (i === 0 || !DATE.test(p.born_on)) return null;
    const age = ageOn(p.born_on, travelDate);
    return age < 18 ? age : null;
  });
}

const NAME = /^[A-Za-z][A-Za-z' -]{0,59}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Client-side mirror of the server's checks — the server stays the authority. */
export function validatePassengerForm(
  quote: Pick<BookingQuote, 'passengers' | 'requirements' | 'slices'>,
  passengers: BookingPassenger[],
  contact: BookingContact,
): PassengerErrors {
  const e: PassengerErrors = {};
  const today = new Date().toISOString().slice(0, 10);
  const travelDate = quote.slices[0]?.departingAt?.slice(0, 10) || today;
  const lastDate = quote.slices[quote.slices.length - 1]?.arrivingAt?.slice(0, 10) || travelDate;
  passengers.forEach((p, i) => {
    const k = (f: string) => `passengers.${i}.${f}`;
    if (!NAME.test(p.given_name.trim())) e[k('given_name')] = 'First name as on the passport (Latin letters).';
    if (!NAME.test(p.family_name.trim())) e[k('family_name')] = 'Last name as on the passport (Latin letters).';
    if (!p.gender) e[k('gender')] = 'Choose the gender on the passport.';
    if (!DATE.test(p.born_on) || p.born_on >= today) {
      e[k('born_on')] = 'Enter a valid date of birth.';
    } else if (i === 0 && ageOn(p.born_on, travelDate) < 18) {
      // Only the lead traveller (the one booking) must be an adult; anyone
      // after can be a child — the fare is re-priced with their ages.
      e[k('born_on')] = 'The first traveller must be 18 or over on the travel date — they are the one booking.';
    }
    if (quote.requirements.identityDocumentsRequired) {
      const pp = p.passport;
      if (!pp || !/^[A-Za-z0-9]{5,20}$/.test(pp.number.trim())) e[k('passport.number')] = 'Enter the passport number.';
      if (!pp || !/^[A-Za-z]{2}$/.test(pp.issuing_country_code.trim()))
        e[k('passport.issuing_country_code')] = 'Two-letter country code, e.g. US.';
      if (!pp || !DATE.test(pp.expires_on) || pp.expires_on <= lastDate)
        e[k('passport.expires_on')] = 'The passport must be valid beyond the travel dates.';
    }
  });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) e['contact.email'] = 'Enter a valid email.';
  if (!/^\+[1-9]\d{6,14}$/.test(contact.phone_number.replace(/[\s()-]/g, '')))
    e['contact.phone_number'] = 'Phone in international format, e.g. +14155550123.';
  return e;
}

const inputCls =
  'w-full h-9 px-3 rounded-lg border text-[13px] text-gray-900 bg-white outline-none focus:border-[#2563eb]';
/** Narrower padding: three of these share one field. */
const selectCls =
  'w-full h-9 px-2 rounded-lg border text-[13px] text-gray-900 bg-white outline-none focus:border-[#2563eb]';
const THIS_YEAR = new Date().getFullYear();

function Field({
  label,
  error,
  children,
  htmlFor,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label htmlFor={htmlFor} className="text-[11px] font-medium text-gray-600">
        {label}
      </label>
      {children}
      {error && (
        <span role="alert" className="text-[11px] text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}

type Props = {
  quote: BookingQuote;
  passengers: BookingPassenger[];
  contact: BookingContact;
  errors: PassengerErrors;
  onChange: (passengers: BookingPassenger[], contact: BookingContact) => void;
};

export default function PassengerForm({ quote, passengers, contact, errors, onChange }: Props) {
  const needsPassport = quote.requirements.identityDocumentsRequired;
  const border = (key: string) => ({ borderColor: errors[key] ? '#dc2626' : 'rgba(0,0,0,0.12)' });

  const set = (i: number, patch: Partial<BookingPassenger>) =>
    onChange(
      passengers.map((p, j) => (j === i ? { ...p, ...patch } : p)),
      contact,
    );
  const setPassport = (i: number, patch: Partial<NonNullable<BookingPassenger['passport']>>) => {
    const cur = passengers[i].passport ?? { number: '', issuing_country_code: '', expires_on: '' };
    set(i, { passport: { ...cur, ...patch } });
  };

  return (
    <div className="flex flex-col gap-4">
      {passengers.map((p, i) => {
        const id = (f: string) => `pax-${i}-${f}`;
        const k = (f: string) => `passengers.${i}.${f}`;
        return (
          <fieldset key={i} className="rounded-xl border p-4 flex flex-col gap-3" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
            <legend className="px-1 text-[12px] font-semibold text-gray-800">
              Traveller {i + 1}
              <span className="font-normal text-gray-500"> · {quote.passengers[i]?.type ?? 'adult'}</span>
            </legend>
            <div className="grid grid-cols-[110px_1fr_1fr] gap-3">
              <Field label="Title (optional)" htmlFor={id('title')} error={errors[k('title')]}>
                <select
                  id={id('title')}
                  className={inputCls}
                  style={border(k('title'))}
                  value={p.title}
                  onChange={(e) => set(i, { title: e.target.value as BookingPassenger['title'] })}
                >
                  <option value="">—</option>
                  <option value="mr">Mr</option>
                  <option value="ms">Ms</option>
                  <option value="mrs">Mrs</option>
                  <option value="miss">Miss</option>
                  <option value="dr">Dr</option>
                </select>
              </Field>
              <Field label="First name" htmlFor={id('given_name')} error={errors[k('given_name')]}>
                <input
                  id={id('given_name')}
                  className={inputCls}
                  style={border(k('given_name'))}
                  value={p.given_name}
                  autoComplete="given-name"
                  onChange={(e) => set(i, { given_name: e.target.value })}
                />
              </Field>
              <Field label="Last name" htmlFor={id('family_name')} error={errors[k('family_name')]}>
                <input
                  id={id('family_name')}
                  className={inputCls}
                  style={border(k('family_name'))}
                  value={p.family_name}
                  autoComplete="family-name"
                  onChange={(e) => set(i, { family_name: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-[1.6fr_1fr] gap-3">
              <Field label="Date of birth" htmlFor={id('born_on')} error={errors[k('born_on')]}>
                <DateSelect
                  id={id('born_on')}
                  label="Date of birth"
                  className={selectCls}
                  style={border(k('born_on'))}
                  value={p.born_on}
                  fromYear={THIS_YEAR}
                  toYear={THIS_YEAR - 110}
                  onChange={(iso) => set(i, { born_on: iso })}
                />
              </Field>
              <Field label="Gender (as on passport)" htmlFor={id('gender')} error={errors[k('gender')]}>
                <select
                  id={id('gender')}
                  className={inputCls}
                  style={border(k('gender'))}
                  value={p.gender}
                  onChange={(e) => set(i, { gender: e.target.value as BookingPassenger['gender'] })}
                >
                  <option value="">—</option>
                  <option value="f">Female</option>
                  <option value="m">Male</option>
                </select>
              </Field>
            </div>
            {needsPassport && (
              <div className="grid grid-cols-[1fr_72px_1.6fr] gap-3">
                <Field label="Passport number" htmlFor={id('passport-number')} error={errors[k('passport.number')] ?? errors[k('passport')]}>
                  <input
                    id={id('passport-number')}
                    className={inputCls}
                    style={border(k('passport.number'))}
                    value={p.passport?.number ?? ''}
                    onChange={(e) => setPassport(i, { number: e.target.value })}
                  />
                </Field>
                <Field label="Issued by" htmlFor={id('passport-country')} error={errors[k('passport.issuing_country_code')]}>
                  <input
                    id={id('passport-country')}
                    className={inputCls}
                    style={border(k('passport.issuing_country_code'))}
                    placeholder="US"
                    maxLength={2}
                    value={p.passport?.issuing_country_code ?? ''}
                    onChange={(e) => setPassport(i, { issuing_country_code: e.target.value.toUpperCase() })}
                  />
                </Field>
                <Field label="Passport expiry" htmlFor={id('passport-expiry')} error={errors[k('passport.expires_on')]}>
                  <DateSelect
                    id={id('passport-expiry')}
                    label="Passport expiry"
                    className={selectCls}
                    style={border(k('passport.expires_on'))}
                    value={p.passport?.expires_on ?? ''}
                    fromYear={THIS_YEAR}
                    toYear={THIS_YEAR + 15}
                    onChange={(iso) => setPassport(i, { expires_on: iso })}
                  />
                </Field>
              </div>
            )}
          </fieldset>
        );
      })}

      <fieldset className="rounded-xl border p-4 flex flex-col gap-3" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
        <legend className="px-1 text-[12px] font-semibold text-gray-800">Contact for this booking</legend>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email" htmlFor="contact-email" error={errors['contact.email']}>
            <input
              id="contact-email"
              type="email"
              className={inputCls}
              style={border('contact.email')}
              value={contact.email}
              autoComplete="email"
              onChange={(e) => onChange(passengers, { ...contact, email: e.target.value })}
            />
          </Field>
          <Field label="Phone" htmlFor="contact-phone" error={errors['contact.phone_number']}>
            <input
              id="contact-phone"
              type="tel"
              className={inputCls}
              style={border('contact.phone_number')}
              placeholder="+14155550123"
              value={contact.phone_number}
              autoComplete="tel"
              onChange={(e) => onChange(passengers, { ...contact, phone_number: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-[11px] text-gray-500">The airline uses these for schedule changes. Names must match each passport.</p>
      </fieldset>
    </div>
  );
}
