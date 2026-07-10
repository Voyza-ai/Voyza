'use client';

import { Plane, TrainFront, Plus, Loader2 } from 'lucide-react';

type CanvasConnectorProps = {
  transport: any;
  canEdit: boolean;
  onAddCity: () => void;
  /** A fresh flight/train search is running for this leg (after a
   *  reorder/add) — show a spinner instead of the stale price. */
  refreshing?: boolean;
};

const MODE_COLORS: Record<string, string> = {
  flight: '#2e6bc4',
  train: '#22c088',
};

export default function CanvasConnector({ transport, canEdit, onAddCity, refreshing = false }: CanvasConnectorProps) {
  const mode = transport?.mode ?? 'flight';
  const accentColor = MODE_COLORS[mode] ?? '#2e6bc4';
  const Icon = mode === 'train' ? TrainFront : Plane;
  const hasPrice = transport?.price > 0;

  return (
    <div className="flex items-center mx-1">
      {/* Left dashed line */}
      <div
        className="w-6 h-[2px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${accentColor}80 0px, ${accentColor}80 5px, transparent 5px, transparent 9px)`,
        }}
      />

      {/* Center: transport pill or add button */}
      <div className="flex flex-col items-center gap-1 mx-1">
        {refreshing ? (
          <>
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center border"
              style={{ background: `${accentColor}12`, borderColor: `${accentColor}30` }}
            >
              <Loader2 size={13} className="animate-spin" style={{ color: accentColor }} />
            </div>
            <div className="text-[9px] text-gray-400">finding route…</div>
          </>
        ) : hasPrice ? (
          <>
            {/* Transport icon badge */}
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center border"
              style={{
                background: `${accentColor}20`,
                borderColor: `${accentColor}40`,
              }}
            >
              <Icon size={13} style={{ color: accentColor }} />
            </div>
            {/* Price badge */}
            <div
              className="px-2 py-0.5 rounded-lg text-[11px] font-semibold border"
              style={{
                background: `${accentColor}15`,
                borderColor: `${accentColor}35`,
                color: accentColor,
              }}
            >
              ${transport.price}
            </div>
            {transport.duration && (
              <div className="text-[9px] text-gray-400">{transport.duration}</div>
            )}
          </>
        ) : (
          /* No transport data — show a neutral dot */
          <div
            className="w-3 h-3 rounded-full border-2"
            style={{ borderColor: `${accentColor}50` }}
          />
        )}

        {/* Add button below connector */}
        {canEdit && (
          <button
            onClick={onAddCity}
            className="w-6 h-6 rounded-full flex items-center justify-center border transition-all hover:scale-110 hover:border-[#2563eb] group"
            style={{
              background: '#ffffff',
              borderColor: 'rgba(0,0,0,0.1)',
            }}
          >
            <Plus size={10} className="text-gray-400 group-hover:text-[#2563eb] transition-colors" />
          </button>
        )}
      </div>

      {/* Right dashed line */}
      <div
        className="w-6 h-[2px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${accentColor}80 0px, ${accentColor}80 5px, transparent 5px, transparent 9px)`,
        }}
      />
    </div>
  );
}
