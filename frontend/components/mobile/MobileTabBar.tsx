'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, Map, User, Plus } from 'lucide-react';
import { M } from './theme';

/**
 * App-level navigation for the mobile shell: Home, a raised "Plan" action in
 * the middle (the thumb's natural spot), My trips and Account.
 */
export default function MobileTabBar() {
  const path = usePathname() ?? '';
  const item = (href: string, label: string, Icon: typeof Compass, active: boolean) => (
    <Link
      href={href}
      className="flex-1 min-h-[52px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium"
      style={{ color: active ? M.blue : '#6b7280' }}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={22} strokeWidth={active ? 2.4 : 2} />
      {label}
    </Link>
  );
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 bg-white border-t"
      style={{ borderColor: M.line, paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Main"
    >
      <div className="mx-auto max-w-[520px] flex items-end px-2">
        {item('/m', 'Explore', Compass, path === '/m')}
        {item('/m/trips', 'My trips', Map, path.startsWith('/m/trips'))}
        <Link
          href="/m/plan"
          className="flex-1 flex flex-col items-center -mt-5 pb-1 text-[11px] font-medium"
          style={{ color: M.blue }}
          aria-label="Plan a trip"
        >
          <span className="w-14 h-14 rounded-full flex items-center justify-center text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)]" style={{ background: M.blue }}>
            <Plus size={26} />
          </span>
          Plan
        </Link>
        {item('/m/account', 'Account', User, path.startsWith('/m/account'))}
      </div>
    </nav>
  );
}
