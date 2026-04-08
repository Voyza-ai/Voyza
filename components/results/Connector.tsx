'use client';

// Plain conditional rendering — no AnimatePresence (it gets stuck mid-exit
// when the tab is throttled or not visible). The morph is now an instant swap.
import {
  Plane,
  TrainFront,
  ArrowRight,
  Clock,
  Luggage,
  ExternalLink,
  X,
} from 'lucide-react';
import { Transport } from '@/lib/types';

type ConnectorProps = {
  transport: Transport;
  index: number;
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

export default function Connector({ transport, index, isExpanded, onToggle }: ConnectorProps) {
  const isFlight = transport.mode === 'flight';
  const Icon = isFlight ? Plane : TrainFront;
  const accentColor = isFlight ? '#4f8ef7' : '#34d399';
  const modeLabel = isFlight ? 'Flight' : 'Train';

  return (
    <div
      className={`flex-shrink-0 flex items-center justify-center self-center transition-[width] duration-300 ease-out ${
        isExpanded ? 'w-[240px] px-3 py-4' : 'w-[170px] px-2 py-12'
      } relative`}
    >
      {/* Dashed line — only when collapsed */}
      {!isExpanded && (
        <svg
          width="170"
          height="2"
          className="absolute top-1/2 -translate-y-1/2"
        >
          <line
            x1="0"
            y1="1"
            x2="170"
            y2="1"
            stroke={accentColor}
            strokeOpacity="0.35"
            strokeWidth="1.5"
            strokeDasharray="5 4"
          />
        </svg>
      )}

      {!isExpanded ? (
        /* COLLAPSED — small icon pill */
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="relative z-10 flex flex-col items-center gap-2 outline-none transition-transform duration-150 hover:scale-[1.04] active:scale-[0.97]"
          aria-label="Show travel details"
        >
            {/* Icon badge */}
            <div
              className="flex items-center justify-center w-11 h-11 rounded-full border backdrop-blur-md"
              style={{
                background: `${accentColor}15`,
                borderColor: `${accentColor}40`,
              }}
            >
              <Icon size={18} style={{ color: accentColor }} />
            </div>

            {/* Info pill */}
            <div
              className="flex flex-col items-center px-3 py-1.5 rounded-xl border backdrop-blur-md"
              style={{
                background: 'rgba(15,15,26,0.85)',
                borderColor: 'rgba(255,255,255,0.08)',
              }}
            >
              <div className="text-white/90 text-[13px] font-semibold">${transport.price}</div>
              <div className="text-white/40 text-[10px] mt-0.5">{transport.duration}</div>
              {transport.departTime && transport.arriveTime && (
                <div className="text-white/55 text-[10px] mt-1 flex items-center gap-1 font-mono">
                  <span>{transport.departTime}</span>
                  <ArrowRight size={8} className="text-white/30" />
                  <span>{transport.arriveTime}</span>
                </div>
              )}
            </div>

            <div className="text-[9px] uppercase tracking-wider text-white/25">
              Click for details
            </div>
        </button>
      ) : (
        /* EXPANDED — full transit card (smaller than CityCard) */
        <div
          className="relative z-10 w-[220px] rounded-2xl border backdrop-blur-xl overflow-hidden"
          style={{
            background: `linear-gradient(160deg, ${accentColor}1a 0%, rgba(15,15,26,0.95) 65%)`,
            borderColor: `${accentColor}55`,
          }}
        >
            {/* Top accent bar */}
            <div
              className="h-[2px] w-full"
              style={{
                background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor}50 100%)`,
              }}
            />

            {/* Header */}
            <div
              className="px-3 pt-3 pb-2 flex items-start justify-between gap-2 border-b"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{
                    background: `${accentColor}1f`,
                    border: `1px solid ${accentColor}50`,
                  }}
                >
                  <Icon size={12} style={{ color: accentColor }} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-[9px] uppercase tracking-wider font-medium"
                      style={{ color: accentColor }}
                    >
                      {modeLabel}
                    </span>
                    {(transport.flightNumber || transport.trainNumber) && (
                      <span className="text-white/35 text-[9px] font-mono">
                        {transport.flightNumber || transport.trainNumber}
                      </span>
                    )}
                  </div>
                  <div className="text-white text-[12px] font-semibold leading-tight truncate mt-0.5">
                    {transport.operator}
                  </div>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="text-white/40 hover:text-white/85 transition-colors flex-shrink-0 -mt-0.5"
                aria-label="Minimize"
              >
                <X size={13} />
              </button>
            </div>

            {/* Date */}
            {transport.departDate && (
              <div className="px-3 pt-2 text-white/45 text-[9px] uppercase tracking-wider">
                {formatDateLong(transport.departDate)}
              </div>
            )}

            {/* Route — vertical timeline */}
            <div className="px-3 py-2">
              <div className="flex items-stretch gap-2.5">
                {/* Timeline column */}
                <div className="flex flex-col items-center pt-1">
                  <div
                    className="w-2 h-2 rounded-full border-2"
                    style={{ borderColor: accentColor, background: 'transparent' }}
                  />
                  <div
                    className="w-px flex-1 my-1"
                    style={{ background: `${accentColor}50` }}
                  />
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ background: accentColor }}
                  />
                </div>

                {/* Route info */}
                <div className="flex-1 flex flex-col gap-2 min-w-0">
                  {/* Depart */}
                  <div>
                    <div className="text-white text-[12px] font-mono font-semibold tabular-nums">
                      {transport.departTime || '—'}
                    </div>
                    <div className="text-white/75 text-[10px] mt-0.5 leading-tight truncate">
                      {transport.from || '—'}
                    </div>
                    {transport.fromStation && (
                      <div className="text-white/35 text-[9px] mt-0.5 truncate">
                        {transport.fromStation}
                      </div>
                    )}
                  </div>

                  {/* Duration */}
                  <div className="flex items-center gap-1 text-white/40 text-[9px]">
                    <Clock size={8} />
                    <span>{transport.duration}</span>
                    {transport.layovers !== undefined && (
                      <span className="text-white/30">
                        ·{' '}
                        {transport.layovers === 0
                          ? 'Direct'
                          : `${transport.layovers} stop${transport.layovers > 1 ? 's' : ''}`}
                      </span>
                    )}
                  </div>

                  {/* Arrive */}
                  <div>
                    <div className="text-white text-[12px] font-mono font-semibold tabular-nums">
                      {transport.arriveTime || '—'}
                    </div>
                    <div className="text-white/75 text-[10px] mt-0.5 leading-tight truncate">
                      {transport.to || '—'}
                    </div>
                    {transport.toStation && (
                      <div className="text-white/35 text-[9px] mt-0.5 truncate">
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
                className="px-3 py-2 border-t flex items-start gap-1.5 text-white/60 text-[10px]"
                style={{ borderColor: 'rgba(255,255,255,0.06)' }}
              >
                <Luggage size={9} className="text-white/35 mt-0.5 flex-shrink-0" />
                <span className="leading-snug">{transport.baggage}</span>
              </div>
            )}

            {/* Footer: price + book */}
            <div
              className="px-3 py-2.5 border-t flex items-center justify-between gap-2"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <div>
                <div className="text-white/40 text-[8px] uppercase tracking-wider">Price</div>
                <div className="text-white text-sm font-semibold">${transport.price}</div>
              </div>
              {transport.bookingUrl ? (
                <a
                  href={transport.bookingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 text-[11px] text-white px-3 py-1.5 rounded-full transition-all hover:brightness-110"
                  style={{ background: accentColor }}
                >
                  Book
                  <ExternalLink size={9} />
                </a>
              ) : (
                <div className="text-white/30 text-[10px]">Soon</div>
              )}
            </div>
        </div>
      )}
    </div>
  );
}
