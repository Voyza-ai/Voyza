'use client';

import { motion } from 'framer-motion';

type LoadingSpinnerProps = {
  size?: number;
  text?: string;
};

export default function LoadingSpinner({
  size = 40,
  text,
}: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center gap-4">
      <motion.div
        className="border-2 border-voyza-border border-t-voyza-accent rounded-full"
        style={{ width: size, height: size }}
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
      />
      {text && (
        <motion.p
          className="text-[#aaaaaa] text-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          {text}
        </motion.p>
      )}
    </div>
  );
}
