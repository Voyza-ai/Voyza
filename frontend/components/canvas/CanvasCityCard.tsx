'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Plus,
  Plane,
  TrainFront,
  Hotel,
  Calendar,
  Star,
  Trash2,
  StickyNote,
  Eye,
  Loader2,
} from 'lucide-react';
import { getCityColor } from '@/lib/cityColors';

type CanvasCityCardProps = {
  city: any;
  index: number;
  role: string;
  isLast: boolean;
  hotelLoading?: boolean;
  onRemove: (index: number) => void;
  onAddAfter: (index: number) => void;
};

const MODE_ICONS: Record<string, typeof Plane> = {
  flight: Plane,
  train: TrainFront,
};

const MODE_COLORS: Record<string, string> = {
  flight: '#2e6bc4',
  train: '#22c088',
};

const formatDate = (iso: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const nightsBetween = (a: string, b: string) => {
  if (!a || !b) return 0;
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  const t1 = new Date(y1, (m1 || 1) - 1, d1 || 1).getTime();
  const t2 = new Date(y2, (m2 || 1) - 1, d2 || 1).getTime();
  return Math.max(0, Math.round((t2 - t1) / (1000 * 60 * 60 * 24)));
};

export default function CanvasCityCard({
  city,
  index,
  role,
  isLast,
  hotelLoading = false,
  onRemove,
  onAddAfter,
}: CanvasCityCardProps) {
  const [hovered, setHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const canEdit = role === 'owner' || role === 'editor';

  const color = getCityColor(city.colorIndex ?? index);
  const hotel = city.hotels?.[city.selectedHotelIndex] ?? city.hotel;
  const transportOut = city.transportOut;
  const TransportIcon = MODE_ICONS[transportOut?.mode] ?? Plane;
  const transportColor = MODE_COLORS[transportOut?.mode] ?? '#2e6bc4';

  const arrival = formatDate(city.dates?.arrival);
  const departure = formatDate(city.dates?.departure);
  const nights = nightsBetween(city.dates?.arrival, city.dates?.departure);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!canEdit) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div className="flex items-center">
      <motion.div
        className="relative flex-shrink-0 w-[260px] rounded-2xl border-2 overflow-hidden cursor-default"
        style={{
          background: color.bg,
          borderColor: hovered ? color.text : color.border,
          boxShadow: hovered ? `0 4px 16px ${color.border}` : '0 1px 4px rgba(0,0,0,0.06)',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={handleContextMenu}
        whileHover={{ scale: 1.02 }}
        transition={{ duration: 0.15 }}
        layout
      >
        {/* Remove button on hover */}
        {canEdit && hovered && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={() => onRemove(index)}
            className="absolute top-2.5 right-2.5 z-10 w-6 h-6 rounded-full flex items-center justify-center bg-red-500/80 hover:bg-red-500 text-white transition-colors shadow-sm"
          >
            <X size={11} />
          </motion.button>
        )}

        {/* City number badge */}
        <div
          className="absolute top-3 right-3 text-[10px] font-semibold leading-none"
          style={{ color: `${color.text}88` }}
        >
          {String(index + 1).padStart(2, '0')}
        </div>

        {/* City header */}
        <div className="px-5 pt-5 pb-1">
          <div className="text-[17px] font-semibold" style={{ color: color.text }}>
            {city.name}
          </div>
          {city.country && (
            <div className="text-[12px] mt-0.5" style={{ color: `${color.text}aa` }}>
              {city.country}
            </div>
          )}
        </div>

        {/* Dates + nights */}
        {(arrival || departure) && (
          <div className="px-5 pb-2 flex items-center gap-1.5">
            <Calendar size={10} style={{ color: `${color.text}88` }} />
            <span className="text-[11px]" style={{ color: `${color.text}cc` }}>
              {arrival}{arrival && departure ? ' → ' : ''}{departure}
              {nights > 0 && (
                <span style={{ color: `${color.text}88` }}>
                  {' '}· {nights} {nights === 1 ? 'night' : 'nights'}
                </span>
              )}
            </span>
          </div>
        )}

        {/* Vibe chips */}
        {city.vibes && city.vibes.length > 0 && (
          <div className="px-5 pb-2 flex flex-wrap gap-1">
            {city.vibes.slice(0, 3).map((v: string) => (
              <span
                key={v}
                className="text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full border"
                style={{
                  background: 'rgba(255,255,255,0.6)',
                  borderColor: `${color.text}30`,
                  color: `${color.text}cc`,
                }}
              >
                {v}
              </span>
            ))}
          </div>
        )}

        {/* Hotel info */}
        {hotel && hotel.name !== 'Select hotel' && (
          <div
            className="mx-4 mb-2 px-3 py-2.5 rounded-xl"
            style={{ background: `${color.text}10` }}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Hotel size={10} style={{ color: `${color.text}88` }} />
              <span className="text-[10px] uppercase tracking-wider" style={{ color: `${color.text}88` }}>
                Stay
              </span>
            </div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold leading-tight truncate" style={{ color: color.text }}>
                  {hotel.name}
                </div>
                {hotel.area && (
                  <div className="text-[10px] mt-0.5 truncate" style={{ color: `${color.text}88` }}>
                    {hotel.area}
                  </div>
                )}
              </div>
              <div className="text-right flex-shrink-0">
                {hotel.rating > 0 && (
                  <div className="flex items-center gap-0.5 text-[#fbbf24] text-[10px]">
                    <Star size={9} fill="currentColor" />
                    <span>{hotel.rating}</span>
                  </div>
                )}
                {hotel.pricePerNight > 0 && (
                  <div className="text-[11px] font-medium" style={{ color: color.text }}>
                    ${hotel.pricePerNight}/n
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Hotel loading state — shown while a freshly added city fetches its hotel */}
        {(!hotel || hotel.name === 'Select hotel') && hotelLoading && (
          <div
            className="mx-4 mb-2 px-3 py-2.5 rounded-xl flex items-center gap-2"
            style={{ background: `${color.text}10` }}
          >
            <Loader2 size={11} className="animate-spin" style={{ color: `${color.text}88` }} />
            <span className="text-[11px]" style={{ color: `${color.text}aa` }}>
              Finding hotel…
            </span>
          </div>
        )}

        {/* Transport to next city */}
        {transportOut && transportOut.price > 0 && !isLast && (
          <div
            className="mx-4 mb-3 px-3 py-2 rounded-xl flex items-center gap-2"
            style={{ background: `${transportColor}12` }}
          >
            <TransportIcon size={11} style={{ color: transportColor }} />
            <span className="text-[11px]" style={{ color: `${transportColor}cc` }}>
              {transportOut.duration}
            </span>
            <span className="text-[12px] font-semibold ml-auto" style={{ color: transportColor }}>
              ${transportOut.price}
            </span>
          </div>
        )}

        {/* Bottom padding for cards without transport */}
        {(!transportOut || transportOut.price <= 0 || isLast) && (
          <div className="pb-3" />
        )}
      </motion.div>

      {/* Context menu */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            ref={contextRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed z-50 w-[180px] rounded-xl border shadow-lg overflow-hidden"
            style={{
              top: contextMenu.y,
              left: contextMenu.x,
              background: '#ffffff',
              borderColor: 'rgba(0,0,0,0.08)',
            }}
          >
            <button
              onClick={() => {
                onRemove(index);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[12px] text-red-600 hover:bg-red-50 transition-colors text-left"
            >
              <Trash2 size={12} />
              Remove city
            </button>
            <div className="h-px bg-gray-100" />
            <button
              onClick={() => {
                onAddAfter(index);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[12px] text-gray-700 hover:bg-gray-50 transition-colors text-left"
            >
              <Plus size={12} />
              Add city after
            </button>
            <div className="h-px bg-gray-100" />
            <button
              onClick={() => setContextMenu(null)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[12px] text-gray-700 hover:bg-gray-50 transition-colors text-left"
            >
              <Eye size={12} />
              View suggestions
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
