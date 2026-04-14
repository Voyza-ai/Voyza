'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Plus, Plane, TrainFront, Hotel, Calendar } from 'lucide-react';

type CanvasCityCardProps = {
  city: any;
  index: number;
  role: string;
  isLast: boolean;
  onRemove: (index: number) => void;
  onAddAfter: (index: number) => void;
};

const MODE_COLORS: Record<string, string> = {
  flight: '#2e6bc4',
  train: '#22c088',
};

export default function CanvasCityCard({
  city,
  index,
  role,
  isLast,
  onRemove,
  onAddAfter,
}: CanvasCityCardProps) {
  const [hovered, setHovered] = useState(false);
  const canEdit = role === 'owner' || role === 'editor';
  const transportOut = city.transportOut;
  const hotel = city.hotels?.[city.selectedHotelIndex] ?? city.hotel;
  const accentColor = MODE_COLORS[transportOut?.mode] ?? '#2e6bc4';

  return (
    <div className="flex items-center">
      <motion.div
        className="relative flex-shrink-0 w-[220px] rounded-2xl border overflow-hidden"
        style={{
          background: 'rgba(255,255,255,0.06)',
          borderColor: 'rgba(255,255,255,0.12)',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        whileHover={{ scale: 1.02 }}
        transition={{ duration: 0.15 }}
      >
        {/* Remove button */}
        {canEdit && hovered && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={() => onRemove(index)}
            className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full flex items-center justify-center bg-red-500/80 hover:bg-red-500 text-white transition-colors"
          >
            <X size={12} />
          </motion.button>
        )}

        {/* City header */}
        <div className="px-4 pt-4 pb-2">
          <div className="text-white text-[15px] font-semibold">{city.name}</div>
          <div className="text-white/40 text-[11px]">{city.country}</div>
        </div>

        {/* Dates */}
        <div className="px-4 pb-2 flex items-center gap-1.5 text-white/50 text-[11px]">
          <Calendar size={10} />
          <span>
            {city.dates?.arrival} — {city.dates?.departure}
          </span>
        </div>

        {/* Hotel info */}
        {hotel && (
          <div className="px-4 pb-2 flex items-center gap-1.5">
            <Hotel size={11} className="text-white/40" />
            <span className="text-white/60 text-[11px] truncate flex-1">{hotel.name}</span>
            <span className="text-white/80 text-[12px] font-medium">
              ${hotel.pricePerNight}/n
            </span>
          </div>
        )}

        {/* Transport to next city */}
        {transportOut && !isLast && (
          <div
            className="px-4 py-2 border-t flex items-center gap-1.5"
            style={{ borderColor: 'rgba(255,255,255,0.08)' }}
          >
            {transportOut.mode === 'flight' ? (
              <Plane size={11} style={{ color: accentColor }} />
            ) : (
              <TrainFront size={11} style={{ color: accentColor }} />
            )}
            <span className="text-white/50 text-[11px]">{transportOut.duration}</span>
            <span className="text-white/80 text-[12px] font-medium ml-auto">
              ${transportOut.price}
            </span>
          </div>
        )}
      </motion.div>

      {/* Connector line + Add button between cards */}
      {!isLast && (
        <div className="flex items-center mx-2">
          <div
            className="w-8 h-px"
            style={{
              background: `linear-gradient(90deg, ${accentColor}60, ${accentColor}30)`,
            }}
          />
          {canEdit && (
            <button
              onClick={() => onAddAfter(index)}
              className="w-7 h-7 rounded-full flex items-center justify-center border transition-all hover:scale-110 active:scale-95"
              style={{
                background: 'rgba(255,255,255,0.06)',
                borderColor: 'rgba(255,255,255,0.15)',
              }}
            >
              <Plus size={12} className="text-white/50" />
            </button>
          )}
          <div
            className="w-8 h-px"
            style={{
              background: `linear-gradient(90deg, ${accentColor}30, ${accentColor}60)`,
            }}
          />
        </div>
      )}
    </div>
  );
}
