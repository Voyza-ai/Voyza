'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import PlaneAnimation from '@/components/welcome/PlaneAnimation';
import LogoReveal from '@/components/welcome/LogoReveal';
import HeroInput from '@/components/welcome/HeroInput';
import WondersBackground from '@/components/welcome/WondersBackground';
import LoginModal from '@/components/shared/LoginModal';
import HomeAuthButton from '@/components/welcome/HomeAuthButton';

export default function WelcomePage() {
  const [phase, setPhase] = useState<
    'waiting' | 'plane' | 'logo' | 'input'
  >('waiting');
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('plane'), 300);
    const t2 = setTimeout(() => setPhase('logo'), 2600);
    const t3 = setTimeout(() => setPhase('input'), 3800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <main
      className="relative h-screen flex flex-col items-center overflow-hidden"
      style={{ background: '#0f0f1a' }}
    >
      {/* Subtle destination photo grid */}
      <WondersBackground />

      {/* Auth corner — "Log in" when signed out, initials avatar when signed in */}
      <motion.div
        className="fixed top-4 right-6 z-50"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase === 'input' ? 1 : 0 }}
        transition={{ duration: 0.4 }}
      >
        <HomeAuthButton onLoginClick={() => setLoginOpen(true)} />
      </motion.div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />

      {/* Plane animation */}
      {(phase === 'waiting' || phase === 'plane') && <PlaneAnimation />}

      {/* Content — BlueMurr at top, content flows down */}
      <div className="relative flex flex-col items-center gap-3 px-4 z-10 pt-[18vh]">
        <LogoReveal show={phase === 'logo' || phase === 'input'} />
        <HeroInput show={phase === 'input'} />
      </div>

      {/* Ambient glow behind content */}
      {(phase === 'logo' || phase === 'input') && (
        <motion.div
          className="absolute w-[600px] h-[600px] rounded-full pointer-events-none z-[5]"
          style={{
            top: '10%',
            background:
              'radial-gradient(circle, rgba(79,142,247,0.08) 0%, transparent 60%)',
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.5 }}
        />
      )}
    </main>
  );
}
