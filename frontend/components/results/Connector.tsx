'use client';

// Plain conditional rendering — no AnimatePresence (it gets stuck mid-exit
// when the tab is throttled or not visible). The morph is now an instant swap.
import { motion } from 'framer-motion';
import {
  Plane,
  TrainFront,
  ArrowRight,
  Clock,
  Luggage,
  ExternalLink,
  X,
  ArrowLeftRight,
} from 'lucide-react';
import { Transport } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { displayAmount } from '@/lib/tripTotals';

type ConnectorProps = {
  transport: Transport;
  index: number;
  cityIndex: number;
  isExpanded: boolean;
  onToggle: () => void;
  /**
   * Optional override for when the user picks a different alternative
   * pill. Default: dispatches setTransportOut(cityIndex, altIdx) on the
   * trip store (works for city-to-city legs). Home legs pass their own
   * handler that calls setHomeLegAlternative('outbound' | 'return', altIdx)
   * instead, since cityIndex is a sentinel (-1, -2) for those.
   */
  onPickAlternative?: (alternativeIndex: number) => void;
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

const MODE_COLORS: Record<string, string> = {
  flight: '#2e6bc4',
  train: '#22c088',
  bus: '#e74c3c',
};

export default function Connector({
  transport,
  cityIndex,
  isExpanded,
  onToggle,
  onPickAlternative,
}: ConnectorProps) {
  const setTransportOut = useTripStore((s) => s.setTransportOut);
  const priceMode = useTripStore((s) => s.priceMode);
  const travelers = useTripStore((s) => s.currentTrip?.travelers ?? 1);
  const pickAlternative = onPickAlternative ?? ((ai: number) => setTransportOut(cityIndex, ai));
  const isFlight = transport.mode === 'flight';
  const isTrain = transport.mode === 'train';
  const Icon = isFlight ? Plane : TrainFront;
  const accentColor = MODE_COLORS[transport.mode] ?? '#2e6bc4';
  const modeLabel = isFlight ? 'Flight' : isTrain ? 'Train' : 'Bus';
  const alternatives = transport.alternatives ?? [];

  // Render an explicit "we couldn't find any transport" pill instead of the
  // normal price/time card. Without this branch the user sees a $0 mode pill
  // with empty time fields and reasonably assumes the app is broken.
  if (transport.unavailable) {
    const fromName = transport.from ?? '';
    const toName = transport.to ?? '';
    const rome2RioUrl = `https://www.rome2rio.com/s/${encodeURIComponent(fromName)}/${encodeURIComponent(toName)}`;
    const dimGray = '#888888';
    return (
      <div className="flex-shrink-0 flex items-center justify-center self-center w-[200px] px-0 py-8 relative">
        <div className="flex items-center w-full">
          <div
            className="flex-1 h-[2px] min-w-[16px]"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${dimGray}aa 0px, ${dimGray}aa 6px, transparent 6px, transparent 11px)`,
            }}
          />
          <div className="relative z-10 flex flex-col items-center gap-1.5 mx-2 w-[140px]">
            <div
              className="flex items-center justify-center w-10 h-10 rounded-full border"
              style={{ background: `${dimGray}25`, borderColor: `${dimGray}55` }}
            >
              <X size={16} style={{ color: dimGray }} />
            </div>
            <div
              className="flex flex-col items-center justify-center px-2 py-1.5 rounded-xl border w-full text-center"
              style={{ background: `${dimGray}15`, borderColor: `${dimGray}55` }}
            >
              <div className="text-gray-700 text-[11px] font-semibold leading-tight">
                No direct option
              </div>
              <a
                href={rome2RioUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] text-gray-600 underline mt-1 hover:text-gray-900"
              >
                Try Rome2Rio
              </a>
            </div>
          </div>
          <div
            className="flex-1 h-[2px] min-w-[16px]"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${dimGray}aa 0px, ${dimGray}aa 6px, transparent 6px, transparent 11px)`,
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex-shrink-0 flex items-center justify-center self-center transition-[width] duration-300 ease-out ${
        isExpanded ? 'w-[560px] px-3 py-4' : 'w-[200px] px-0 py-8'
      } relative`}
    >
      {!isExpanded ? (
        /* COLLAPSED — dashed line → pill → dashed line layout.
           Every transport card has identical dimensions regardless of
           mode or data completeness — only the icon differs. This
           keeps the dashed segments at the same Y position across all
           connectors on the flowchart. */
        <div className="flex items-center w-full">
          {/* Left dashed segment */}
          <motion.div
            className="flex-1 h-[2px] min-w-[16px] origin-right"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1], delay: 0.2 }}
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${accentColor}aa 0px, ${accentColor}aa 6px, transparent 6px, transparent 11px)`,
            }}
          />

          {/* Center pill — clickable. Fixed width + height so every
              connector pill is the same size. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="relative z-10 flex flex-col items-center gap-1.5 outline-none transition-transform duration-150 hover:scale-[1.04] active:scale-[0.97] mx-2 w-[120px]"
            aria-label="Show travel details"
          >
            {/* Icon badge */}
            <div
              className="flex items-center justify-center w-10 h-10 rounded-full border"
              style={{
                background: `${accentColor}30`,
                borderColor: `${accentColor}55`,
              }}
            >
              <Icon size={16} style={{ color: accentColor }} />
            </div>

            {/* Info pill — fixed height so pills are identical even
                when departTime/arriveTime are missing. We always
                render all three rows and fall back to placeholders
                when data is absent. */}
            <div
              className="flex flex-col items-center justify-center px-3 py-1.5 rounded-xl border w-full h-[64px]"
              style={{
                background: `${accentColor}25`,
                borderColor: `${accentColor}55`,
              }}
            >
              <div className="text-gray-900 text-[13px] font-bold leading-none">${displayAmount(transport.price, priceMode, travelers).toLocaleString()}</div>
              <div className="text-gray-600 text-[10px] mt-1 leading-none">{transport.duration || '—'}</div>
              <div className="text-gray-700 text-[10px] mt-1.5 flex items-center gap-1 font-mono leading-none">
                <span>{transport.departTime || '—:—'}</span>
                <ArrowRight size={8} className="text-gray-500" />
                <span>{transport.arriveTime || '—:—'}</span>
              </div>
            </div>

            <div className="text-[9px] uppercase tracking-wider text-gray-500">
              Click for details
            </div>
          </button>

          {/* Right dashed segment */}
          <motion.div
            className="flex-1 h-[2px] min-w-[16px] origin-left"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1], delay: 0.2 }}
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${accentColor}aa 0px, ${accentColor}aa 6px, transparent 6px, transparent 11px)`,
            }}
          />
        </div>
      ) : (
        /* EXPANDED — horizontal transit card (wide, short) */
        <div
          className="relative z-10 w-[540px] rounded-2xl border backdrop-blur-xl overflow-hidden"
          style={{
            background: `${accentColor}20`,
            borderColor: `${accentColor}50`,
            boxShadow: `0 4px 20px rgba(0,0,0,0.06)`,
          }}
        >
          {/* Top accent bar */}
          <div
            className="h-[2px] w-full"
            style={{
              background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor}50 100%)`,
            }}
          />

          {/* Header row: operator + date + close */}
          <div
            className="px-4 pt-3 pb-2.5 flex items-center justify-between gap-3 border-b"
            style={{ borderColor: 'rgba(0,0,0,0.08)' }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: `${accentColor}30`,
                  border: `1px solid ${accentColor}50`,
                }}
              >
                <Icon size={14} style={{ color: accentColor }} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[11px] uppercase tracking-wider font-semibold"
                    style={{ color: accentColor }}
                  >
                    {modeLabel}
                  </span>
                  {(transport.flightNumber || transport.trainNumber) && (
                    <span className="text-gray-600 text-[11px] font-mono">
                      {transport.flightNumber || transport.trainNumber}
                    </span>
                  )}
                </div>
                <div className="text-gray-900 text-[14px] font-semibold leading-tight truncate">
                  {transport.operator}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              {transport.departDate && (
                <div className="text-gray-600 text-[11px] uppercase tracking-wider">
                  {formatDateLong(transport.departDate)}
                </div>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="text-gray-400 hover:text-gray-800 transition-colors"
                aria-label="Minimize"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Route row — horizontal: depart · duration · arrive */}
          <div className="px-4 py-3.5 flex items-center gap-3">
            {/* Depart block */}
            <div className="flex-1 min-w-0">
              <div className="text-gray-900 text-[18px] font-mono font-semibold tabular-nums leading-none">
                {transport.departTime || '—'}
              </div>
              <div className="text-gray-700 text-[12px] mt-1 leading-tight truncate">
                {transport.from || '—'}
              </div>
              {transport.fromStation && (
                <div className="text-gray-400 text-[11px] mt-0.5 truncate">
                  {transport.fromStation}
                </div>
              )}
            </div>

            {/* Center: duration + direct/layovers */}
            <div className="flex-shrink-0 flex flex-col items-center gap-1 px-2">
              <div className="flex items-center gap-1 text-gray-600 text-[11px]">
                <Clock size={11} />
                <span className="font-medium">{transport.duration}</span>
              </div>
              <div className="flex items-center gap-1 w-full">
                <div
                  className="w-1.5 h-1.5 rounded-full border-[1.5px] flex-shrink-0"
                  style={{ borderColor: accentColor }}
                />
                <div
                  className="flex-1 h-px"
                  style={{ background: `${accentColor}50` }}
                />
                <ArrowRight size={11} style={{ color: accentColor }} />
                <div
                  className="flex-1 h-px"
                  style={{ background: `${accentColor}50` }}
                />
                <div
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: accentColor }}
                />
              </div>
              {transport.layovers !== undefined && (
                <div className="text-gray-400 text-[10px]">
                  {transport.layovers === 0
                    ? 'Direct'
                    : `${transport.layovers} stop${transport.layovers > 1 ? 's' : ''}`}
                </div>
              )}
            </div>

            {/* Arrive block */}
            <div className="flex-1 min-w-0 text-right">
              <div className="text-gray-900 text-[18px] font-mono font-semibold tabular-nums leading-none">
                {transport.arriveTime || '—'}
              </div>
              <div className="text-gray-700 text-[12px] mt-1 leading-tight truncate">
                {transport.to || '—'}
              </div>
              {transport.toStation && (
                <div className="text-gray-400 text-[11px] mt-0.5 truncate">
                  {transport.toStation}
                </div>
              )}
            </div>
          </div>

          {/* Baggage + price + book — single row */}
          <div
            className="px-4 py-2.5 border-t flex items-center justify-between gap-3"
            style={{ borderColor: 'rgba(0,0,0,0.08)' }}
          >
            {transport.baggage && (
              <div className="flex items-center gap-1.5 text-gray-500 text-[11px] min-w-0">
                <Luggage size={12} className="text-gray-400 flex-shrink-0" />
                <span className="truncate">{transport.baggage}</span>
              </div>
            )}
            <div className="flex items-center gap-3 flex-shrink-0">
              <div className="text-gray-900 text-[17px] font-semibold tabular-nums">
                ${displayAmount(transport.price, priceMode, travelers).toLocaleString()}
              </div>
              {transport.bookingUrl ? (
                <a
                  href={transport.bookingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 text-[12px] font-medium text-white px-3.5 py-1.5 rounded-full transition-all hover:brightness-110"
                  style={{ background: accentColor }}
                >
                  Book
                  <ExternalLink size={11} />
                </a>
              ) : (
                <div className="text-gray-300 text-[11px]">Soon</div>
              )}
            </div>
          </div>

          {/* Honest note: we searched for a train on this (short) route and
              found none, so we say so instead of silently showing only flights. */}
          {transport.noTrainData && (
            <div
              className="px-4 py-2.5 border-t flex items-center gap-1.5"
              style={{ borderColor: 'rgba(0,0,0,0.08)' }}
            >
              <TrainFront size={12} style={{ color: '#888', opacity: 0.6 }} />
              <span className="text-gray-500 text-[11px]">
                No live train data for this leg — showing flights only.
              </span>
            </div>
          )}

          {/* Top 4 cheapest options — mixed-mode pills (flight, train,
              and eventually bus). Sorted cheapest-first. The currently
              selected option is rendered as the main card above; this
              row is just the swap menu. */}
          {alternatives.length > 0 && (
            <div
              className="px-4 py-3 border-t"
              style={{ borderColor: 'rgba(0,0,0,0.08)' }}
            >
              <div className="text-gray-600 text-[10px] uppercase tracking-wider mb-2 font-medium">
                Cheapest options
              </div>
              <div className="flex gap-2">
                {alternatives.map((alt, ai) => {
                  const altIsFlight = alt.mode === 'flight';
                  const AltIcon = altIsFlight ? Plane : TrainFront;
                  const altAccent = MODE_COLORS[alt.mode] ?? '#2e6bc4';
                  return (
                    <button
                      key={ai}
                      onClick={(e) => {
                        e.stopPropagation();
                        pickAlternative(ai);
                      }}
                      className="group flex-1 min-w-0 flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-all text-left"
                      style={{
                        background: `${altAccent}18`,
                        borderColor: `${altAccent}40`,
                      }}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                          style={{
                            background: `${altAccent}28`,
                            border: `1px solid ${altAccent}50`,
                          }}
                        >
                          <AltIcon size={10} style={{ color: altAccent }} />
                        </div>
                        <span className="text-gray-900 text-[13px] font-semibold tabular-nums">
                          ${displayAmount(alt.price, priceMode, travelers).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-baseline gap-1 text-gray-800 text-[11px] font-mono tabular-nums">
                        <span>{alt.departTime}</span>
                        <span className="text-gray-300 text-[9px]">→</span>
                        <span>{alt.arriveTime}</span>
                      </div>
                      <div className="flex items-center gap-1 text-gray-600 text-[10px]">
                        <Clock size={9} className="text-gray-400 flex-shrink-0" />
                        <span className="font-medium">{alt.duration}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1 pt-0.5 border-t border-gray-200">
                        <span className="text-gray-600 text-[10px] truncate">
                          {alt.operator}
                        </span>
                        <ArrowLeftRight
                          size={10}
                          className="text-gray-300 group-hover:text-gray-700 transition-colors flex-shrink-0"
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
