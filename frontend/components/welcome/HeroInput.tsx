'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

type HeroInputProps = {
  show: boolean;
};

export default function HeroInput({ show }: HeroInputProps) {
  const router = useRouter();

  if (!show) return null;

  const handleSubmit = () => {
    router.push('/main');
  };

  return (
    <motion.div
      className="flex flex-col items-center w-full max-w-lg"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2, ease: 'easeOut' }}
    >
      {/* Get started button */}
      <motion.button
        onClick={handleSubmit}
        className="flex items-center gap-2 bg-[#4f8ef7] hover:bg-[#3d7de6] text-white font-medium px-7 py-3 rounded-full text-[15px] shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.1 }}
      >
        Get started
        <ArrowRight size={18} />
      </motion.button>
    </motion.div>
  );
}
