import { getCityColor } from '@/lib/cityColors';

/**
 * Mini-flowchart preview of a trip's route: one pastel chip per city (the
 * same palette the results flowchart uses), joined by the dashed-route
 * connector. City sequence only — no flight detail. Pure render, so it
 * works in server components (SEO pages) and client cards alike.
 */
export default function MiniRoute({ cities }: { cities: Array<{ name: string }> }) {
  return (
    <ol aria-label="Route" className="flex flex-wrap items-center gap-y-1.5 min-w-0">
      {cities.map((c, i) => {
        const color = getCityColor(i);
        return (
          <li key={`${c.name}-${i}`} className="flex items-center">
            {i > 0 && (
              <span
                aria-hidden
                className="w-3 mx-1 border-t border-dashed"
                style={{ borderColor: '#94a3b8' }}
              />
            )}
            <span
              className="px-1.5 py-0.5 rounded-md border text-[10px] font-medium leading-none whitespace-nowrap"
              style={{ background: color.bg, borderColor: color.border, color: color.text }}
            >
              {c.name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
