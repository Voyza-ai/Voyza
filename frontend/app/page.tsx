'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import PlaneAnimation from '@/components/welcome/PlaneAnimation';
import LogoReveal from '@/components/welcome/LogoReveal';
import HeroTripInput from '@/components/welcome/HeroTripInput';
import AltitudeBackground from '@/components/welcome/AltitudeBackground';
import LoginModal from '@/components/shared/LoginModal';
import HomeAuthButton from '@/components/welcome/HomeAuthButton';

/**
 * Landing — dusk flight.
 *
 * Voyza's own dark surface (the planning chat's #0f0f1a family) as a dusk
 * gradient sky, with an editorial hero (serif-italic accent word), a
 * travel-site white search bar as the primary action, real secondary
 * buttons in the app's button language, and the plane drawing its dashed
 * route low across the sky while the content settles in — no gate.
 *
 * Influences mapped onto Voyza's DNA: Airbnb/Kayak dark-hero search bar
 * (form first), Stripe serif-accent headline + specific copy, planning-
 * chat button styling for secondary actions.
 */
export default function WelcomePage() {
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <main
      className="relative h-screen flex flex-col items-center overflow-hidden"
      style={{ background: '#0f0f1a' }}
    >
      {/* Dusk sky: stars, horizon glow, drifting cloud deck */}
      <AltitudeBackground />

      {/* The flight — draws the dashed route + pastel pins low in the sky */}
      <PlaneAnimation />

      {/* Top bar: wordmark left, auth right */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-7 py-5">
        <motion.span
          className="text-[20px] font-extrabold tracking-tight select-none"
          style={{ color: '#4f8ef7', textShadow: '0 0 24px rgba(79,142,247,0.4)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
        >
          VOYZA
        </motion.span>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <HomeAuthButton onLoginClick={() => setLoginOpen(true)} />
        </motion.div>
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />

      {/* Hero column */}
      <div className="relative flex flex-col items-center gap-9 px-4 z-10 pt-[23vh] w-full">
        <LogoReveal />
        <HeroTripInput />
      </div>
    </main>
  );
}
