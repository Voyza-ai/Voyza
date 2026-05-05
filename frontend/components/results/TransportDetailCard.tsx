'use client';

import { motion } from 'framer-motion';
import {
  Plane,
  TrainFront,
  Clock,
  Luggage,
  ExternalLink,
  X,
} from 'lucide-react';
import { Transport } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { displayAmount } from '@/lib/tripTotals';

type TransportDetailCardProps = {
  transport: Transport;
  onClose: () => void;
};

const formatDateLong = (iso?: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
};

export default function TransportDetailCard({ transport, onClose }: TransportDetailCardProps) {
  const priceMode = useTripStore((s) => s.priceMode);
  const travelers = useTripStore((s) => s.currentTrip?.travelers ?? 1);
  const isFlight = transport.mode === 'flight';
  const Icon = isFlight ? Plane : TrainFront;
  const accentColor = isFlight ? '#2e6bc4' : '#22c088';
  const modeLabel = isFlight ? 'Flight' : 'Train';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, width: 0 }}
      animate={{ opacity: 1, scale: 1, width: 300 }}
      exit={{ opacity: 0, scale: 0.92, width: 0 }}
      transition={{
        opacity: { duration: 0.25 },
        scale: { type: 'spring', stiffness: 240, damping: 22 },
        width: { type: 'spring', stiffness: 260, damping: 28 },
      }}
      className="flex-shrink-0 rounded-3xl border backdrop-blur-xl overflow-hidden self-center"
      style={{
        background: `linear-gradient(160deg, ${accentColor}12 0%, #ffffff 60%)`,
        borderColor: `${accentColor}40`,
        boxShadow: `0 4px 24px rgba(0,0,0,0.08), 0 0 0 1px ${accentColor}20`,
      }}
    >
      {/* Top accent bar */}
      <div
        className="h-[3px] w-full"
        style={{
          background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor}60 100%)`,
        }}
      />

      {/* Header */}
      <div
        className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 border-b"
        style={{ borderColor: 'rgba(0,0,0,0.08)' }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
            style={{
              background: `${accentColor}12`,
              border: `1px solid ${accentColor}35`,
            }}
          >
            <Icon size={15} style={{ color: accentColor }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="text-[10px] uppercase tracking-wider font-medium"
                style={{ color: accentColor }}
              >
                {modeLabel}
              </span>
              {(transport.flightNumber || transport.trainNumber) && (
                <span className="text-gray-600 text-[10px] font-mono">
                  {transport.flightNumber || transport.trainNumber}
                </span>
              )}
            </div>
            <div className="text-gray-900 text-[14px] font-semibold leading-tight truncate mt-0.5">
              {transport.operator}
            </div>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="text-gray-400 hover:text-gray-800 transition-colors flex-shrink-0 -mt-0.5"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Date */}
      {transport.departDate && (
        <div className="px-5 pt-3 text-gray-600 text-[10px] uppercase tracking-wider">
          {formatDateLong(transport.departDate)}
        </div>
      )}

      {/* Route — vertical timeline */}
      <div className="px-5 py-3">
        <div className="flex items-stretch gap-3">
          {/* Timeline column */}
          <div className="flex flex-col items-center pt-1.5">
            <div
              className="w-2.5 h-2.5 rounded-full border-2"
              style={{ borderColor: accentColor, background: 'transparent' }}
            />
            <div
              className="w-px flex-1 my-1"
              style={{ background: `${accentColor}40` }}
            />
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: accentColor }}
            />
          </div>

          {/* Route info */}
          <div className="flex-1 flex flex-col gap-3 min-w-0">
            {/* Depart */}
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-gray-900 text-[15px] font-mono font-semibold tabular-nums">
                  {transport.departTime || '—'}
                </div>
                <div className="text-gray-600 text-[10px] uppercase tracking-wider">
                  Depart
                </div>
              </div>
              <div className="text-gray-700 text-[12px] mt-0.5 leading-tight truncate">
                {transport.from || '—'}
              </div>
              {transport.fromStation && (
                <div className="text-gray-400 text-[11px] mt-0.5 truncate">
                  {transport.fromStation}
                </div>
              )}
            </div>

            {/* Duration row */}
            <div className="flex items-center gap-1.5 text-gray-500 text-[11px]">
              <Clock size={10} />
              <span>{transport.duration}</span>
              {transport.layovers !== undefined && (
                <span className="text-gray-400">
                  ·{' '}
                  {transport.layovers === 0
                    ? 'Direct'
                    : `${transport.layovers} stop${transport.layovers > 1 ? 's' : ''}`}
                </span>
              )}
            </div>

            {/* Arrive */}
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-gray-900 text-[15px] font-mono font-semibold tabular-nums">
                  {transport.arriveTime || '—'}
                </div>
                <div className="text-gray-600 text-[10px] uppercase tracking-wider">
                  Arrive
                </div>
              </div>
              <div className="text-gray-700 text-[12px] mt-0.5 leading-tight truncate">
                {transport.to || '—'}
              </div>
              {transport.toStation && (
                <div className="text-gray-400 text-[11px] mt-0.5 truncate">
                  {transport.toStation}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Baggage */}
      {transport.baggage && (
        <div
          className="px-5 py-2.5 border-t flex items-start gap-2 text-gray-600 text-[11px]"
          style={{ borderColor: 'rgba(0,0,0,0.08)' }}
        >
          <Luggage size={11} className="text-gray-400 mt-0.5 flex-shrink-0" />
          <span className="leading-snug">{transport.baggage}</span>
        </div>
      )}

      {/* Footer: price + book */}
      <div
        className="px-5 py-3 border-t flex items-center justify-between gap-3"
        style={{ borderColor: 'rgba(0,0,0,0.08)' }}
      >
        <div>
          <div className="text-gray-600 text-[9px] uppercase tracking-wider">Price</div>
          <div className="text-gray-900 text-base font-semibold">${displayAmount(transport.price, priceMode, travelers).toLocaleString()}</div>
        </div>
        {transport.bookingUrl ? (
          <a
            href={transport.bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 text-[12px] text-white px-3.5 py-2 rounded-full transition-all hover:brightness-110"
            style={{ background: accentColor }}
          >
            Book
            <ExternalLink size={11} />
          </a>
        ) : (
          <div className="text-gray-300 text-[11px]">Booking link soon</div>
        )}
      </div>
    </motion.div>
  );
}
