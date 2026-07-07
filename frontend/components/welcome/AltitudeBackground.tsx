'use client';

/**
 * Landing background v3 — "window seat at 38,000 ft".
 *
 * Replaces the faded 7-wonders photo grid (at 12% opacity the photos read
 * as mud, not places). Instead: a dusk sky at cruising altitude — stars in
 * the upper sky, a warm horizon band low on the screen, and thin cloud
 * layers drifting below at different speeds for parallax depth. Puts the
 * viewer IN the flight the intro is flying.
 *
 * All deterministic (no Math.random → SSR-safe), transform/opacity-only
 * animations, reduced-motion respected.
 */

const STARS = Array.from({ length: 34 }, (_, i) => ({
  left: (i * 137.508) % 100,           // golden-angle spread
  top: (i * 61.8 + 5) % 52,            // upper half of the sky
  size: 1 + (i % 3) * 0.6,
  duration: 2.8 + (i % 5) * 0.9,
  delay: (i % 7) * 0.6,
  bright: i % 5 === 0,
}));

/** Cloud bands: [top%, width%, height px, opacity, drift s, delay s] */
const CLOUDS: [number, number, number, number, number, number][] = [
  [64, 58, 44, 0.05, 95, 0],
  [70, 44, 36, 0.07, 75, -18],
  [76, 66, 52, 0.06, 115, -40],
  [83, 50, 40, 0.08, 85, -60],
  [90, 72, 56, 0.05, 130, -25],
];

export default function AltitudeBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      <style jsx>{`
        @keyframes cloudDrift {
          from { transform: translate3d(-12%, 0, 0); }
          to   { transform: translate3d(12%, 0, 0); }
        }
        @keyframes starTwinkle {
          0%, 100% { opacity: 0.10; }
          50%      { opacity: 0.85; }
        }
        @media (prefers-reduced-motion: reduce) {
          .alt-cloud, .alt-star { animation: none !important; }
        }
      `}</style>

      {/* Sky gradient: deep night above → dusk blue → warm horizon band */}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(180deg,
            #0a0e1e 0%,
            #0e1430 34%,
            #16204a 58%,
            #2b3a6e 72%,
            #6a5a7e 80%,
            #c8825f 86%,
            #1a1430 92%,
            #0d0a1a 100%)`,
        }}
      />

      {/* Horizon glow — the thin bright line where the sun just set */}
      <div
        className="absolute left-0 right-0"
        style={{
          top: '84.5%',
          height: '3px',
          background:
            'linear-gradient(90deg, transparent 0%, rgba(255,190,130,0.55) 30%, rgba(255,214,160,0.85) 50%, rgba(255,190,130,0.55) 70%, transparent 100%)',
          filter: 'blur(2px)',
        }}
      />

      {/* Stars — upper sky, staggered twinkle */}
      <div className="absolute inset-0">
        {STARS.map((s, i) => (
          <span
            key={i}
            className="alt-star absolute rounded-full"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              background: s.bright ? 'rgba(214,230,255,0.95)' : 'rgba(255,255,255,0.7)',
              boxShadow: s.bright ? '0 0 6px rgba(170,205,255,0.9)' : 'none',
              opacity: 0.1,
              animation: `starTwinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
            }}
          />
        ))}
      </div>

      {/* Cloud deck — soft blurred bands drifting at different speeds */}
      {CLOUDS.map(([top, width, height, opacity, duration, delay], i) => (
        <div
          key={i}
          className="alt-cloud absolute rounded-[999px]"
          style={{
            top: `${top}%`,
            left: `${(i * 23) % 45}%`,
            width: `${width}%`,
            height: `${height}px`,
            background: `radial-gradient(ellipse at center, rgba(255,255,255,${opacity * 2}) 0%, rgba(255,255,255,0) 70%)`,
            filter: 'blur(14px)',
            animation: `cloudDrift ${duration}s ease-in-out ${delay}s infinite alternate`,
          }}
        />
      ))}

      {/* Center vignette so the wordmark + input stay crisp */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 50% 38%, rgba(10, 12, 26, 0.35) 0%, transparent 70%)',
        }}
      />
    </div>
  );
}
