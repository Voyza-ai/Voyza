'use client';

import { motion } from 'framer-motion';
import { MapPin, Users, DollarSign } from 'lucide-react';
import { Trip } from '@/lib/types';

type TripCardProps = {
  trip: Trip;
  onClick?: () => void;
};

export default function TripCard({ trip, onClick }: TripCardProps) {
  return (
    <motion.div
      onClick={onClick}
      className="bg-voyza-card border border-voyza-border rounded-2xl p-5 cursor-pointer hover:border-voyza-accent/50 hover:bg-voyza-card-hover transition-all"
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
    >
      <h3 className="text-lg font-medium mb-3">{trip.title}</h3>

      <div className="flex items-center gap-4 text-sm text-[#aaaaaa]">
        <span className="flex items-center gap-1">
          <MapPin size={14} />
          {trip.cities.length} cities
        </span>
        <span className="flex items-center gap-1">
          <Users size={14} />
          {trip.travelers}
        </span>
        <span className="flex items-center gap-1">
          <DollarSign size={14} />
          ${trip.totalCost}
        </span>
      </div>

      {trip.savings > 0 && (
        <div className="mt-3">
          <span className="text-xs text-voyza-success bg-voyza-success/10 px-2 py-1 rounded-full">
            Saving ${trip.savings}
          </span>
        </div>
      )}
    </motion.div>
  );
}
