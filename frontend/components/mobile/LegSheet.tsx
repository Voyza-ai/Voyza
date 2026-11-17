'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plane, TrainFront, ArrowRight, Check, ExternalLink, Clock, Luggage } from 'lucide-react';
import type { Transport, Trip } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { displayAmount } from '@/lib/tripTotals';
import { humanDay } from '@/lib/dateHelpers';
import BookingModal from '@/components/booking/BookingModal';
import BottomSheet from './BottomSheet';
import { legTransport, type LegRef } from './MobileItinerary';
import { M } from './theme';

type Props = {
  trip: Trip;
  leg: LegRef | null;
  onClose: () => void;
  /** This person may change the trip (swap to an alternative, book). */
  editable: boolean;
  /** Demo builds open no booking flow. */
  bookingDisabled?: boolean;
};

const stopsText = (n?: number) => (typeof n !== 'number' ? null : n === 0 ? 'Nonstop' : `${n} stop${n > 1 ? 's' : ''}`);

/**
 * A leg's details and its other options — the flowchart's expanded
 * connector card as a sheet. Picking an option is the same store action the
 * desktop card's pills dispatch (setTransportOut / setHomeLegAlternative).
 */
export default function LegSheet({ trip, leg, onClose, editable, bookingDisabled }: Props) {
  const priceMode = useTripStore((s) => s.priceMode);
  const setTransportOut = useTripStore((s) => s.setTransportOut);
  const setHomeLegAlternative = useTripStore((s) => s.setHomeLegAlternative);
  const [booking, setBooking] = useState(false);

  const t = leg ? legTransport(trip, leg) : null;
  const legDate =
    leg?.kind === 'city' ? trip.cities[leg.index]?.dates.departure : undefined;
  const from = t?.from ?? '';
  const to = t?.to ?? '';
  const money = (n: number) => `$${displayAmount(n, priceMode, trip.travelers).toLocaleString()}`;
  const unitNote = priceMode === 'perPerson' && trip.travelers > 1 ? 'per person' : trip.travelers > 1 ? `for ${trip.travelers}` : '';

  const pick = (altIdx: number) => {
    if (!leg) return;
    if (leg.kind === 'city') setTransportOut(leg.index, altIdx);
    else setHomeLegAlternative(leg.kind, altIdx);
  };

  const isFlight = t?.mode === 'flight';
  const accent = isFlight ? M.flight : M.train;
  const Icon = isFlight ? Plane : TrainFront;
  const bookDate = t?.departDate ?? legDate;
  const canBookInApp = !bookingDisabled && isFlight && !t?.unavailable && !!bookDate && !!from && !!to;

  return (
    <>
      <BottomSheet
        open={!!leg}
        onClose={onClose}
        title={
          <span className="flex items-center gap-2">
            {from} <ArrowRight size={16} className="text-gray-400" /> {to}
          </span>
        }
        subtitle={bookDate ? humanDay(bookDate) : undefined}
        testId="m-leg-sheet"
      >
        {!t || (!t.operator && !t.price && !t.unavailable) ? (
          <p className="px-5 pb-8 text-[15px] text-gray-600">Nothing is booked for this leg yet — BlueMurr is still looking, or you can ask the AI to find options.</p>
        ) : t.unavailable ? (
          <div className="px-5 pb-8 flex flex-col gap-3">
            <p className="text-[15px] text-gray-700">No direct flight or train was found for this leg.</p>
            <a
              href={`https://www.rome2rio.com/s/${encodeURIComponent(from)}/${encodeURIComponent(to)}`}
              target="_blank"
              rel="noreferrer"
              className="min-h-[48px] flex items-center justify-center gap-2 rounded-2xl border text-[15px] font-medium"
              style={{ borderColor: M.line, color: M.blue }}
            >
              Try Rome2Rio <ExternalLink size={15} />
            </a>
          </div>
        ) : (
          <div className="px-5 pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-4">
            {/* Selected option */}
            <div className="rounded-2xl border p-4" style={{ borderColor: `${accent}55`, background: `${accent}0d` }}>
              <div className="flex items-center gap-2.5">
                <span className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: `${accent}22`, color: accent }}>
                  <Icon size={18} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[16px] font-semibold text-gray-900 truncate">{t.operator || (isFlight ? 'Flight' : 'Train')}</div>
                  <div className="text-[12px] text-gray-500">
                    {isFlight ? 'Flight' : 'Train'}
                    {t.flightNumber ? ` · ${t.flightNumber}` : t.trainNumber ? ` · ${t.trainNumber}` : ''}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[20px] font-bold tabular-nums" style={{ color: accent }}>{money(t.price)}</div>
                  {unitNote && <div className="text-[11px] text-gray-500">{unitNote}</div>}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <div>
                  <div className="text-[22px] font-semibold tabular-nums text-gray-900">{t.departTime || '—:—'}</div>
                  <div className="text-[12px] text-gray-500 truncate">{t.fromStation || from}</div>
                </div>
                <div className="flex flex-col items-center text-[11px] text-gray-500">
                  <Clock size={13} />
                  {t.duration || '—'}
                </div>
                <div className="text-right">
                  <div className="text-[22px] font-semibold tabular-nums text-gray-900">{t.arriveTime || '—:—'}</div>
                  <div className="text-[12px] text-gray-500 truncate">{t.toStation || to}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-gray-600">
                {stopsText(t.layovers) && <span className="px-2 py-1 rounded-full bg-white border" style={{ borderColor: M.line }}>{stopsText(t.layovers)}</span>}
                {t.baggage && (
                  <span className="px-2 py-1 rounded-full bg-white border flex items-center gap-1" style={{ borderColor: M.line }}>
                    <Luggage size={12} /> {t.baggage}
                  </span>
                )}
              </div>
            </div>

            {/* Book */}
            {canBookInApp ? (
              <button
                onClick={() => setBooking(true)}
                className="min-h-[52px] rounded-2xl text-[16px] font-semibold text-white"
                style={{ background: M.blue }}
              >
                Book this flight
              </button>
            ) : t.bookingUrl && !bookingDisabled ? (
              <a
                href={t.bookingUrl}
                target="_blank"
                rel="noreferrer"
                className="min-h-[52px] flex items-center justify-center gap-2 rounded-2xl text-[16px] font-semibold text-white"
                style={{ background: M.blue }}
              >
                Book with {t.operator || 'the operator'} <ExternalLink size={15} />
              </a>
            ) : null}

            {/* Other options */}
            {(t.alternatives?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-2" data-testid="m-leg-options">
                <div className="text-[13px] font-semibold text-gray-500 uppercase tracking-wide">Other options</div>
                {t.alternatives!.map((alt, ai) => {
                  const AltIcon = alt.mode === 'flight' ? Plane : TrainFront;
                  const diff = alt.price - t.price;
                  return (
                    <button
                      key={ai}
                      disabled={!editable}
                      onClick={() => pick(ai)}
                      className="min-h-[60px] flex items-center gap-3 rounded-2xl border bg-white px-3 py-2 text-left active:bg-gray-50 disabled:opacity-70"
                      style={{ borderColor: M.line }}
                      data-testid="m-leg-option"
                    >
                      <AltIcon size={17} style={{ color: alt.mode === 'flight' ? M.flight : M.train }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-semibold text-gray-900 truncate">
                          {alt.operator || (alt.mode === 'flight' ? 'Flight' : 'Train')} · {alt.departTime || '—'} → {alt.arriveTime || '—'}
                        </div>
                        <div className="text-[12px] text-gray-500">{[alt.duration, stopsText(alt.layovers)].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[15px] font-bold tabular-nums text-gray-900">{money(alt.price)}</div>
                        <div className={`text-[11px] ${diff < 0 ? 'text-emerald-600' : 'text-gray-500'}`}>
                          {diff === 0 ? 'same' : `${diff < 0 ? '−' : '+'}${money(Math.abs(diff))}`}
                        </div>
                      </div>
                      {editable && <Check size={16} className="text-gray-300" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </BottomSheet>
      {booking &&
        t &&
        bookDate &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="relative z-[70]">
            <BookingModal transport={t} date={bookDate} travelers={trip.travelers} tripId={trip.id ?? null} onClose={() => setBooking(false)} />
          </div>,
          document.body,
        )}
    </>
  );
}
