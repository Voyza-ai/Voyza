'use client';

import { useState, useRef, useEffect, useId } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Utensils,
  Plus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Trip, Restaurant } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { getCityColor } from '@/lib/cityColors';

type ActivitiesDetailPanelProps = {
  trip: Trip;
  cityIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
};

export default function ActivitiesDetailPanel({
  trip,
  cityIndex,
  onClose,
  onPrev,
  onNext,
}: ActivitiesDetailPanelProps) {
  const city = trip.cities[cityIndex];
  const color = getCityColor(city.colorIndex ?? cityIndex);
  const canPrev = cityIndex > 0;
  const canNext = cityIndex < trip.cities.length - 1;

  const addActivity = useTripStore((s) => s.addActivity);
  const removeActivity = useTripStore((s) => s.removeActivity);
  const updateActivity = useTripStore((s) => s.updateActivity);
  const addRestaurant = useTripStore((s) => s.addRestaurant);
  const removeRestaurant = useTripStore((s) => s.removeRestaurant);
  const updateRestaurant = useTripStore((s) => s.updateRestaurant);

  /* Scoped scrollbar */
  const uid = useId().replace(/:/g, '');
  const scrollCls = `adp-scroll-${uid}`;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
      className="h-full flex flex-col rounded-3xl border-2 overflow-hidden relative"
      style={{ background: color.bg, borderColor: color.border }}
    >
      <style>{`
        .${scrollCls}::-webkit-scrollbar { width: 5px; }
        .${scrollCls}::-webkit-scrollbar-track { background: transparent; }
        .${scrollCls}::-webkit-scrollbar-thumb { background: ${color.border}; border-radius: 3px; }
        .${scrollCls}::-webkit-scrollbar-thumb:hover { background: ${color.text}60; }
      `}</style>

      {/* Top accent bar */}
      <div className="h-[5px] w-full flex-shrink-0" style={{ background: color.text }} />

      {/* Header */}
      <div
        className="px-7 pt-6 pb-5 flex items-start justify-between gap-4 flex-shrink-0"
        style={{ borderBottom: `4px solid ${color.border}` }}
      >
        <div className="min-w-0">
          <div
            className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] mb-2"
            style={{ color: `${color.text}aa` }}
          >
            <span>Activities & Dining</span>
          </div>
          <h2
            className="text-3xl font-semibold leading-tight"
            style={{ color: color.text }}
          >
            {city.name}
            <span
              className="text-xl font-normal ml-3"
              style={{ color: `${color.text}88` }}
            >
              {city.country}
            </span>
          </h2>
          <div
            className="flex items-center gap-3 mt-2 text-sm"
            style={{ color: `${color.text}88` }}
          >
            <span>
              {city.activities.length}{' '}
              {city.activities.length === 1 ? 'activity' : 'activities'}
            </span>
            <span style={{ color: `${color.text}40` }}>·</span>
            <span>
              {city.restaurants.length}{' '}
              {city.restaurants.length === 1 ? 'restaurant' : 'restaurants'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={onPrev}
            disabled={!canPrev}
            className="w-8 h-8 rounded-full border flex items-center justify-center transition-all disabled:opacity-25 disabled:cursor-not-allowed"
            style={{
              borderColor: color.border,
              color: color.text,
              background: `${color.text}0c`,
            }}
            aria-label="Previous city"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!canNext}
            className="w-8 h-8 rounded-full border flex items-center justify-center transition-all disabled:opacity-25 disabled:cursor-not-allowed"
            style={{
              borderColor: color.border,
              color: color.text,
              background: `${color.text}0c`,
            }}
            aria-label="Next city"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-1 w-8 h-8 rounded-full border flex items-center justify-center transition-all"
            style={{
              borderColor: color.border,
              color: color.text,
              background: `${color.text}0c`,
            }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body — two-column: activities LEFT, restaurants RIGHT */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-0">
        {/* LEFT: Activities */}
        <div
          className={`px-7 py-6 overflow-y-auto min-h-0 ${scrollCls}`}
          style={{ borderRight: `4px solid ${color.border}` }}
        >
          <ActivityList
            activities={city.activities}
            cityIndex={cityIndex}
            color={color}
            onAdd={addActivity}
            onRemove={removeActivity}
            onUpdate={updateActivity}
          />
        </div>

        {/* RIGHT: Restaurants */}
        <div
          className={`px-7 py-6 overflow-y-auto min-h-0 ${scrollCls}`}
          style={{ background: `${color.text}06` }}
        >
          <RestaurantList
            restaurants={city.restaurants}
            cityIndex={cityIndex}
            color={color}
            onAdd={addRestaurant}
            onRemove={removeRestaurant}
            onUpdate={updateRestaurant}
          />
        </div>
      </div>
    </motion.div>
  );
}

/* ----------------------------- Activities column ----------------------------- */

function ActivityList({
  activities,
  cityIndex,
  color,
  onAdd,
  onRemove,
  onUpdate,
}: {
  activities: string[];
  cityIndex: number;
  color: { bg: string; text: string; border: string; name: string };
  onAdd: (ci: number, a: string) => void;
  onRemove: (ci: number, ai: number) => void;
  onUpdate: (ci: number, ai: number, v: string) => void;
}) {
  const accent = color.text;
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newValue, setNewValue] = useState('');
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAdd) addRef.current?.focus();
  }, [showAdd]);

  const startEdit = (i: number) => {
    setEditingIdx(i);
    setEditValue(activities[i]);
  };
  const saveEdit = () => {
    if (editingIdx === null) return;
    const t = editValue.trim();
    if (t) onUpdate(cityIndex, editingIdx, t);
    setEditingIdx(null);
  };
  const handleAdd = () => {
    const t = newValue.trim();
    if (!t) return;
    onAdd(cityIndex, t);
    setNewValue('');
    // keep the add form open so they can quickly add more
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div
          className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold"
          style={{ color: accent }}
        >
          <MapPin size={12} />
          <span>Things to do</span>
        </div>
        <span className="text-[10px]" style={{ color: `${accent}60` }}>
          {activities.length} {activities.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      <div className="flex flex-col gap-2 flex-1">
        {activities.map((a, i) => (
          <div
            key={i}
            className="group flex items-center gap-3 rounded-2xl px-4 py-3 transition-all"
            style={{ background: `${accent}08`, border: `1px solid ${color.border}` }}
          >
            <span
              className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0"
              style={{ background: `${accent}18`, color: accent }}
            >
              {i + 1}
            </span>

            {editingIdx === i ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={saveEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit();
                  if (e.key === 'Escape') setEditingIdx(null);
                }}
                className="flex-1 text-[14px] bg-transparent border-b-2 focus:outline-none py-0.5"
                style={{ color: `${accent}cc`, borderColor: accent }}
              />
            ) : (
              <span
                className="flex-1 text-[14px] leading-snug cursor-pointer"
                style={{ color: `${accent}cc` }}
                onClick={() => startEdit(i)}
              >
                {a}
              </span>
            )}

            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => startEdit(i)}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                style={{ color: `${accent}70`, background: `${accent}10` }}
                title="Edit"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => onRemove(cityIndex, i)}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                style={{ color: `${accent}70`, background: `${accent}10` }}
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}

        {/* Add form — inline */}
        {showAdd ? (
          <div
            className="flex items-center gap-2 rounded-2xl border px-4 py-3"
            style={{ borderColor: color.border, background: `${accent}06` }}
          >
            <span
              className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0"
              style={{ background: `${accent}18`, color: `${accent}60` }}
            >
              +
            </span>
            <input
              ref={addRef}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
                if (e.key === 'Escape') {
                  setShowAdd(false);
                  setNewValue('');
                }
              }}
              placeholder="e.g. Visit the Colosseum"
              className="flex-1 text-[14px] bg-transparent focus:outline-none"
              style={{ color: accent }}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newValue.trim()}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
              style={{ background: accent, color: color.bg }}
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAdd(false);
                setNewValue('');
              }}
              className="w-6 h-6 flex items-center justify-center"
              style={{ color: `${accent}60` }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-3 text-[13px] transition-all hover:border-solid"
            style={{ borderColor: color.border, color: `${accent}70` }}
          >
            <Plus size={14} />
            <span>Add activity</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Restaurants column ----------------------------- */

function RestaurantList({
  restaurants,
  cityIndex,
  color,
  onAdd,
  onRemove,
  onUpdate,
}: {
  restaurants: Restaurant[];
  cityIndex: number;
  color: { bg: string; text: string; border: string; name: string };
  onAdd: (ci: number, r: Restaurant) => void;
  onRemove: (ci: number, ri: number) => void;
  onUpdate: (ci: number, ri: number, u: Partial<Restaurant>) => void;
}) {
  const accent = color.text;
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editCuisine, setEditCuisine] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCuisine, setNewCuisine] = useState('');
  const [newPrice, setNewPrice] = useState('$$');
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAdd) addRef.current?.focus();
  }, [showAdd]);

  const startEdit = (i: number) => {
    setEditingIdx(i);
    setEditName(restaurants[i].name);
    setEditCuisine(restaurants[i].cuisine);
  };
  const saveEdit = () => {
    if (editingIdx === null) return;
    const n = editName.trim();
    if (n) onUpdate(cityIndex, editingIdx, { name: n, cuisine: editCuisine.trim() || restaurants[editingIdx].cuisine });
    setEditingIdx(null);
  };
  const handleAdd = () => {
    const n = newName.trim();
    if (!n) return;
    onAdd(cityIndex, {
      name: n,
      cuisine: newCuisine.trim() || 'Restaurant',
      priceRange: newPrice,
    });
    setNewName('');
    setNewCuisine('');
    setNewPrice('$$');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div
          className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold"
          style={{ color: accent }}
        >
          <Utensils size={12} />
          <span>Where to eat</span>
        </div>
        <span className="text-[10px]" style={{ color: `${accent}60` }}>
          {restaurants.length} {restaurants.length === 1 ? 'spot' : 'spots'}
        </span>
      </div>

      <div className="flex flex-col gap-2 flex-1">
        {restaurants.map((r, i) => (
          <div
            key={i}
            className="group flex items-center gap-3 rounded-2xl px-4 py-3 transition-all"
            style={{ background: `${accent}08`, border: `1px solid ${color.border}` }}
          >
            <span
              className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0"
              style={{ background: `${accent}18`, color: accent }}
            >
              {i + 1}
            </span>

            {editingIdx === i ? (
              <div className="flex-1 flex flex-col gap-1">
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') setEditingIdx(null);
                  }}
                  className="text-[14px] bg-transparent border-b-2 focus:outline-none py-0.5"
                  style={{ color: `${accent}cc`, borderColor: accent }}
                  placeholder="Restaurant name"
                />
                <input
                  value={editCuisine}
                  onChange={(e) => setEditCuisine(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') setEditingIdx(null);
                  }}
                  onBlur={saveEdit}
                  className="text-[12px] bg-transparent border-b focus:outline-none py-0.5"
                  style={{ color: `${accent}88`, borderColor: `${accent}40` }}
                  placeholder="Cuisine"
                />
              </div>
            ) : (
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => startEdit(i)}
              >
                <div className="text-[14px] leading-snug truncate" style={{ color: `${accent}cc` }}>
                  {r.name}
                </div>
                <div className="text-[11px] flex items-center gap-1.5 mt-0.5" style={{ color: `${accent}70` }}>
                  <span>{r.cuisine}</span>
                  <span style={{ color: `${accent}40` }}>·</span>
                  <span>{r.priceRange}</span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => startEdit(i)}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                style={{ color: `${accent}70`, background: `${accent}10` }}
                title="Edit"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => onRemove(cityIndex, i)}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                style={{ color: `${accent}70`, background: `${accent}10` }}
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}

        {/* Add restaurant form */}
        {showAdd ? (
          <div
            className="rounded-2xl border px-4 py-3 flex flex-col gap-2.5"
            style={{ borderColor: color.border, background: `${accent}06` }}
          >
            <input
              ref={addRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) handleAdd();
                if (e.key === 'Escape') {
                  setShowAdd(false);
                  setNewName('');
                  setNewCuisine('');
                }
              }}
              placeholder="Restaurant name"
              className="w-full text-[14px] bg-transparent focus:outline-none"
              style={{ color: accent }}
            />
            <div className="flex items-center gap-2">
              <input
                value={newCuisine}
                onChange={(e) => setNewCuisine(e.target.value)}
                placeholder="Cuisine (e.g. Italian)"
                className="flex-1 text-[12px] bg-transparent focus:outline-none"
                style={{ color: `${accent}aa` }}
              />
              <div
                className="flex items-center gap-0.5 rounded-lg border p-0.5"
                style={{ borderColor: color.border }}
              >
                {['$', '$$', '$$$', '$$$$'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setNewPrice(p)}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-all"
                    style={{
                      background: newPrice === p ? accent : 'transparent',
                      color: newPrice === p ? color.bg : `${accent}70`,
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setNewName('');
                  setNewCuisine('');
                }}
                className="text-[11px] px-2 py-1"
                style={{ color: `${accent}60` }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={!newName.trim()}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
                style={{ background: accent, color: color.bg }}
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-3 text-[13px] transition-all hover:border-solid"
            style={{ borderColor: color.border, color: `${accent}70` }}
          >
            <Plus size={14} />
            <span>Add restaurant</span>
          </button>
        )}
      </div>
    </div>
  );
}
