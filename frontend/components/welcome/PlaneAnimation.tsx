'use client';

/**
 * Welcome-screen flight intro, v3.
 *
 * A properly-drawn jet (gradient fuselage, swept VOYZA-blue tail, engine
 * nacelle, cockpit, pulsing beacon + wingtip nav light) flies a 3s eased
 * S-curve and draws a dashed route behind it — the same route language as
 * the flowchart connectors and the Map tab. Destination pins pop in as it
 * passes. After the flyby the scene settles into a faint ambient layer
 * behind the logo instead of vanishing.
 *
 * Engineering notes:
 *   - The flight path is INLINED on <animateMotion path=…> — the previous
 *     <mpath href> reference silently failed to resolve in some browsers,
 *     which left the plane parked invisibly at the origin.
 *   - The dashed route is revealed through a stroke-dashoffset mask driven
 *     by the same normalized 0–1 clock (pathLength="1"), so its leading
 *     edge always trails the plane exactly.
 *   - Pure SVG/CSS. prefers-reduced-motion → settled state, no flight.
 */

type PlaneAnimationProps = {
  /** Render the settled ambient state immediately (no flight). */
  ambient?: boolean;
};

export default function PlaneAnimation({ ambient = false }: PlaneAnimationProps) {
  // Gentle S: enter low-left, crest through the middle, climb out right.
  const FLIGHT_PATH = 'M -140 640 C 180 420 360 300 620 330 S 1080 480 1360 210';
  const DURATION = '3s';

  // Destination pins just off the route, popping as the plane passes.
  const PINS = [
    { x: 250, y: 448, color: '#E2725B', delay: 0.9 },
    { x: 620, y: 362, color: '#3D8BFF', delay: 1.55 },
    { x: 1000, y: 486, color: '#2FB57C', delay: 2.2 },
    { x: 1338, y: 246, color: '#9B7BF5', delay: 2.75 },
  ];

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none z-[6]"
      aria-hidden
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
        className={`voyza-flight-scene ${ambient ? 'voyza-ambient' : ''}`}
      >
        <defs>
          {/* Route stroke — brightens toward the plane */}
          <linearGradient id="voyza-route-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(79,142,247,0.30)" />
            <stop offset="60%" stopColor="rgba(124,160,255,0.70)" />
            <stop offset="100%" stopColor="rgba(196,218,255,0.95)" />
          </linearGradient>

          {/* Jet body: white top → cool belly shadow */}
          <linearGradient id="voyza-jet-body" x1="0" y1="-14" x2="0" y2="14" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="62%" stopColor="#eef4fd" />
            <stop offset="100%" stopColor="#c9d9f2" />
          </linearGradient>

          {/* Tail livery — VOYZA blue sweep */}
          <linearGradient id="voyza-jet-tail" x1="0" y1="-30" x2="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#5f9bff" />
            <stop offset="100%" stopColor="#2e6bc4" />
          </linearGradient>

          <filter id="voyza-soft-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Progressive route reveal — a fat sweep inside a mask */}
          <mask id="voyza-route-reveal">
            <path
              className="voyza-route-mask"
              d={FLIGHT_PATH}
              pathLength="1"
              stroke="#fff"
              strokeWidth="28"
              strokeLinecap="round"
              fill="none"
            />
          </mask>
        </defs>

        <style>{`
          @keyframes voyzaRouteDraw {
            0%   { stroke-dashoffset: 1; }
            8%   { stroke-dashoffset: 1; }
            100% { stroke-dashoffset: 0.085; }
          }
          .voyza-route-mask {
            stroke-dasharray: 1;
            stroke-dashoffset: 1;
            animation: voyzaRouteDraw 3s cubic-bezier(0.45, 0.05, 0.35, 1) forwards;
          }

          /* Scene settles into a faint ambient layer after the flight */
          @keyframes voyzaSceneSettle {
            to { opacity: 0.22; }
          }
          .voyza-flight-scene {
            animation: voyzaSceneSettle 1.5s ease-out 3.4s forwards;
          }

          @keyframes voyzaPlaneFade { to { opacity: 0; } }
          .voyza-plane {
            animation: voyzaPlaneFade 0.5s ease-out 2.9s forwards;
          }

          /* Aviation beacon (red, atop the tail) + wingtip strobe */
          @keyframes voyzaBeacon {
            0%, 82%, 100% { opacity: 0.15; }
            88%           { opacity: 1; }
          }
          .voyza-beacon { animation: voyzaBeacon 1.1s linear infinite; }
          @keyframes voyzaStrobe {
            0%, 90%, 100% { opacity: 0.1; }
            94%           { opacity: 1; }
          }
          .voyza-strobe { animation: voyzaStrobe 1.4s linear infinite; }

          /* Destination pins: pop + one ring, then slow idle pulse */
          @keyframes voyzaPinPop {
            0%   { opacity: 0; transform: scale(0); }
            60%  { opacity: 1; transform: scale(1.3); }
            100% { opacity: 1; transform: scale(1); }
          }
          @keyframes voyzaPinRing {
            0%   { opacity: 0.85; transform: scale(0.4); }
            100% { opacity: 0;    transform: scale(2.5); }
          }
          @keyframes voyzaPinIdle {
            0%, 100% { opacity: 0.85; }
            50%      { opacity: 0.5; }
          }
          .voyza-pin, .voyza-pin-ring {
            transform-box: fill-box;
            transform-origin: center;
            opacity: 0;
          }
          .voyza-pin {
            animation:
              voyzaPinPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
              voyzaPinIdle 3.6s ease-in-out 4s infinite;
          }
          .voyza-pin-ring { animation: voyzaPinRing 1s ease-out forwards; }

          @media (prefers-reduced-motion: reduce) {
            .voyza-route-mask { animation: none; stroke-dashoffset: 0.085; }
            .voyza-flight-scene { animation: none; opacity: 0.22; }
            .voyza-plane { animation: none; opacity: 0; }
            .voyza-pin { animation: none; opacity: 0.85; }
            .voyza-pin-ring { animation: none; opacity: 0; }
          }

          /* Ambient mode — jump to the settled end state */
          .voyza-ambient.voyza-flight-scene { animation: none; opacity: 0.22; }
          .voyza-ambient .voyza-route-mask { animation: none; stroke-dashoffset: 0.085; }
          .voyza-ambient .voyza-plane { animation: none; opacity: 0; }
          .voyza-ambient .voyza-pin { animation: voyzaPinIdle 3.6s ease-in-out infinite; opacity: 0.85; }
          .voyza-ambient .voyza-pin-ring { animation: none; opacity: 0; }
        `}</style>

        {/* Soft under-glow, then the dashed route — both mask-revealed */}
        <g mask="url(#voyza-route-reveal)">
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke="rgba(120,170,255,0.28)"
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
            style={{ filter: 'blur(5px)' }}
          />
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke="url(#voyza-route-grad)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray="0.010 0.012"
            fill="none"
            style={{ filter: 'drop-shadow(0 0 5px rgba(79,142,247,0.5))' }}
          />
        </g>

        {/* Destination pins */}
        {PINS.map((pin, i) => (
          <g key={i}>
            <circle
              className="voyza-pin-ring"
              cx={pin.x}
              cy={pin.y}
              r="9"
              fill="none"
              stroke={pin.color}
              strokeWidth="1.5"
              style={{ animationDelay: `${pin.delay + 0.15}s` }}
            />
            <circle
              className="voyza-pin"
              cx={pin.x}
              cy={pin.y}
              r="4.5"
              fill={pin.color}
              stroke="rgba(255,255,255,0.9)"
              strokeWidth="1.4"
              style={{
                animationDelay: `${pin.delay}s, 4s`,
                filter: `drop-shadow(0 0 6px ${pin.color})`,
              }}
            />
          </g>
        ))}

        {/* ── The jet ──────────────────────────────────────────────
            Side profile, nose pointing +x, centered on (0,0).
            Flies the inlined path with tangent rotation; speed is eased
            (slow lift-off → cruise → gentle level-out) via keyPoints. */}
        <g className="voyza-plane" filter="url(#voyza-soft-glow)">
          <animateMotion
            dur={DURATION}
            fill="freeze"
            rotate="auto"
            calcMode="spline"
            keyPoints="0;0.3;0.78;1"
            keyTimes="0;0.38;0.75;1"
            keySplines="0.45 0 0.6 1; 0.4 0 0.6 1; 0.4 0 0.55 1"
            path={FLIGHT_PATH}
          />

          <g transform="scale(1.7)">
            {/* Tail fin — swept, VOYZA livery */}
            <path
              d="M -34 -3 L -46 -26 Q -47.5 -29 -44 -29 L -36 -29 Q -32.5 -29 -30.5 -26 L -21 -4 Z"
              fill="url(#voyza-jet-tail)"
              stroke="rgba(28,52,94,0.35)"
              strokeWidth="0.8"
            />
            {/* Beacon light on the fin tip */}
            <circle className="voyza-beacon" cx="-41.5" cy="-29.5" r="1.6" fill="#ff5a5a"
              style={{ filter: 'drop-shadow(0 0 4px rgba(255,90,90,0.9))' }} />

            {/* Horizontal stabilizer */}
            <path
              d="M -33 -2 L -46 -9 Q -48 -10 -47.5 -7.5 L -45 0.5 L -33 1.5 Z"
              fill="#dbe7f8"
              stroke="rgba(28,52,94,0.3)"
              strokeWidth="0.7"
            />

            {/* Fuselage — long, pointed nose, rounded tail cone */}
            <path
              d="M -38 -1
                 Q -37 -7.5 -28 -8.5
                 L 26 -8.5
                 Q 44 -8 54 -2.5
                 Q 58 -0.5 54 1.5
                 Q 46 6.5 28 7.5
                 L -26 7.5
                 Q -36 6.5 -38 -1 Z"
              fill="url(#voyza-jet-body)"
              stroke="rgba(28,52,94,0.4)"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />

            {/* Belly accent stripe */}
            <path
              d="M -30 4.5 L 30 4.2 Q 40 3.6 47 1.5 L 46 3 Q 38 6.4 28 7 L -25 7 Z"
              fill="rgba(79,142,247,0.35)"
              stroke="none"
            />

            {/* Cockpit windshield */}
            <path
              d="M 40 -6.5 Q 49 -5 52.5 -2 L 44 -2 Q 41 -2.5 40 -6.5 Z"
              fill="#22344f"
              opacity="0.85"
            />

            {/* Window strip */}
            <line x1="-24" y1="-2.6" x2="34" y2="-2.6"
              stroke="rgba(46,84,140,0.55)" strokeWidth="1.7"
              strokeLinecap="round" strokeDasharray="2.4 2.6" />

            {/* Main wing — swept back, foreground */}
            <path
              d="M 10 3 L -6 3 L -24 22 Q -25.5 24 -22.5 24 L -4 24 Q 0 24 2 21.5 L 14 5.5 Z"
              fill="#e6eefb"
              stroke="rgba(28,52,94,0.35)"
              strokeWidth="0.8"
              strokeLinejoin="round"
            />
            {/* Wingtip nav light */}
            <circle className="voyza-strobe" cx="-21" cy="23" r="1.4" fill="#7affc4"
              style={{ filter: 'drop-shadow(0 0 4px rgba(122,255,196,0.9))' }} />

            {/* Engine nacelle under the wing */}
            <g>
              <rect x="-2" y="9.5" width="16" height="8" rx="4"
                fill="#f4f8fe" stroke="rgba(28,52,94,0.4)" strokeWidth="0.8" />
              <ellipse cx="-2" cy="13.5" rx="2.2" ry="4" fill="#22344f" opacity="0.8" />
              <rect x="3" y="10.4" width="9" height="1.6" rx="0.8" fill="rgba(79,142,247,0.4)" />
            </g>

            {/* Far-side wing hint (above fuselage, subdued) */}
            <path
              d="M 4 -7.5 L -8 -7.5 L -17 -15.5 Q -18 -16.5 -15.8 -16.5 L 2 -16.5 Q 4.5 -16.5 5.5 -14.5 L 8 -8.5 Z"
              fill="rgba(196,214,240,0.55)"
              stroke="rgba(28,52,94,0.2)"
              strokeWidth="0.6"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
