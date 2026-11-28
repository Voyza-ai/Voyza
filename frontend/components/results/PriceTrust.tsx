'use client';

import { AlertTriangle, HelpCircle } from 'lucide-react';
import type { PriceTrust } from '@/lib/hotelPriceTrust';

/**
 * The caveat on a hotel price we cannot stand behind (lib/hotelPriceTrust.ts).
 * Drawn in the city's own colour with a dashed border — the product's
 * dashed-route motif reads as "not settled" without a new warning colour.
 */
export function PriceTrustChip({ trust, accent, size = 'sm' }: { trust: PriceTrust; accent: string; size?: 'sm' | 'xs' }) {
  const Icon = trust.kind === 'suspect' ? AlertTriangle : HelpCircle;
  const xs = size === 'xs';
  return (
    <span
      data-testid={`price-trust-${trust.kind}`}
      title={trust.detail}
      className={`inline-flex items-center gap-1 rounded-full border border-dashed uppercase tracking-wider font-medium whitespace-nowrap ${
        xs ? 'text-[8px] px-1.5 py-0.5' : 'text-[9px] px-1.5 py-0.5'
      }`}
      style={{ borderColor: `${accent}90`, color: accent, background: 'transparent' }}
    >
      <Icon size={xs ? 8 : 9} />
      {trust.label}
    </span>
  );
}

/** The same caveat, spelled out — for the selected stay, above its booking link. */
export function PriceTrustNote({ trust, accent }: { trust: PriceTrust; accent: string }) {
  const Icon = trust.kind === 'suspect' ? AlertTriangle : HelpCircle;
  return (
    <div
      data-testid={`price-trust-note-${trust.kind}`}
      className="flex items-start gap-2 rounded-xl border border-dashed px-3 py-2 text-[12px] leading-snug"
      style={{ borderColor: `${accent}80`, color: `${accent}dd` }}
    >
      <Icon size={13} className="mt-[1px] flex-shrink-0" />
      <span>
        <span className="font-semibold">{trust.label}.</span> {trust.detail}
      </span>
    </div>
  );
}
