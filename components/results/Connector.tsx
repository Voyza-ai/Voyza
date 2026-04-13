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

type ConnectorProps = {
  transport: Transport;
  index: number;
  cityIndex: number;
  isExpanded: boolean;
  onToggle: () => void;
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

export default function Connector({ transport, cityIndex, isExpanded, onToggle }: ConnectorProps) {
  const setTransportOut = useTripStore((s) => s.setTransportOut);
  const isFlight = transport.mode === 'flight';
  const isTrain = transport.mode === 'train';
  const Icon = isFlight ? Plane : TrainFront;
  const accentColor = MODE_COLORS[transport.mode] ?? '#2e6bc4';
  const modeLabel = isFlight ? 'Flight' : isTrain ? 'Train' : 'Bus';
  const alternatives = transport.alternatives ?? [];

  return (
    <div
      className={`flex-shrink-0 flex items-center justify-center self-center transition-[width] duration-300 ease-out ${
        isExpanded ? 'w-[560px] px-3 py-4' : 'w-[200px] px-0 py-8'
      } relative`}
    >
      {!isExpanded ? (
        /* COLLAPSED — dashed line → pill → dashed line layout */
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

          {/* Center pill — clickable */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="relative z-10 flex flex-col items-center gap-1.5 outline-none transition-transform duration-150 hover:scale-[1.04] active:scale-[0.97] mx-2"
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

            {/* Info pill */}
            <div
              className="flex flex-col items-center px-3 py-1.5 rounded-xl border"
              style={{
                background: `${accentColor}25`,
                borderColor: `${accentColor}55`,
              }}
            >
              <div className="text-gray-900 text-[13px] font-bold">${transport.price}</div>
              <div className="text-gray-600 text-[10px] mt-0.5">{transport.duration}</div>
              {transport.departTime && transport.arriveTime && (
                <div className="text-gray-700 text-[10px] mt-1 flex items-center gap-1 font-mono">
                  <span>{transport.departTime}</span>
                  <ArrowRight size={8} className="text-gray-500" />
                  <span>{transport.arriveTime}</span>
                </div>
              )}
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
                ${transport.price}
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

          {/* Other options — horizontal row of alternative pills */}
          {alternatives.length > 0 && (
            <div
              className="px-4 py-3 border-t"
              style={{ borderColor: 'rgba(0,0,0,0.08)' }}
            >
              <div className="text-gray-600 text-[10px] uppercase tracking-wider mb-2 font-medium">
                Other options
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
                        setTransportOut(cityIndex, ai);
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
                          ${alt.price}
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
