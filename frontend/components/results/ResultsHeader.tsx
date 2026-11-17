'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Users, TrendingDown, Sparkles, Share2, ChevronDown, CheckCircle2, Send, Copy, Eye } from 'lucide-react';
import { Trip } from '@/lib/types';
import { liveTripTotal } from '@/lib/tripTotals';
import { vibeList } from '@/lib/vibes';
import { waysToSave, type SaveOption } from '@/lib/waysToSave';
import { tripSpan } from '@/lib/tripSpan';
import { useCountUp } from '@/lib/useCountUp';
import {
  stashCanvasIntent,
  readCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  type CanvasIntent,
} from '@/lib/canvasHandoff';
import { useAuthStore } from '@/store/authStore';
import { useTripStore, tripPicksSettled } from '@/store/tripStore';
import LoginModal from '@/components/shared/LoginModal';
import TripNameEditor from '@/components/shared/TripNameEditor';
import { updateTrip } from '@/lib/api';
import { useLeaveGuardSave } from '@/lib/leaveGuard';
import CollaboratorAvatars from './CollaboratorAvatars';
import type { TripCollaboration } from '@/hooks/useTripCollaboration';

import { useResultsHeader, type ResultsHeaderProps } from './useResultsHeader';

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function ResultsHeader({ trip, pricedTrip, collab, onOpenShare, membersKey = 0, canEdit = true }: ResultsHeaderProps) {
  const {
    shown,
    router,
    user,
    setTrip,
    showLoginModal,
    setShowLoginModal,
    saving,
    setSaving,
    renameError,
    setRenameError,
    alreadySaved,
    handleRename,
    buildShareIntent,
    latestTrip,
    saveThisTrip,
    afterSignIn,
    requestSave,
    handleShare,
    handleLoginSuccess,
    role,
    canShare,
    canRename,
    startDate,
    endDate,
    totalNights,
    liveTotal,
    travelers,
    baseline,
    liveSavings,
    shiftSavings,
    shiftIsBest,
    bestSavings,
    nothingToSave,
    showPriceBox,
    shiftDateNice,
    shiftOptions,
    saveOptions,
    applySaveOption,
    shiftMenuOpen,
    setShiftMenuOpen,
    shiftMenuRef,
    offsetLabel,
    addDaysIso,
    applyDateShift,
    niceFullDate,
    priceMode,
    setPriceMode,
    displayedTotal,
    displayedSavings,
    animatedTotal,
    animatedSavings,
    altTotal,
    showToggle,
  } = useResultsHeader({ trip, pricedTrip, collab, onOpenShare, membersKey, canEdit });

  return (
    <div className="px-4 pt-3 pb-0">
      {/* Left: meta, title, then the trip's price boxes under the title.
          Right: who's on the trip + Share. The left column shrinks
          (flex-1 + min-w-0) so a long route title truncates instead of
          pushing the right cluster onto a second row. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* One line. With a collaborator's buttons on the right the row is
              short of room: wrapping left "3 stops" alone on a second line,
              and clipping cut it to "3". Each fact is one unit (its dot
              included); a unit that doesn't fit drops to a second line that
              the fixed height hides, so it disappears whole. */}
          <div className="flex items-center gap-x-3 flex-wrap h-[18px] overflow-hidden whitespace-nowrap text-xs mb-0.5">
            <div className="flex items-center gap-2 text-[#2e6bc4] uppercase tracking-[0.18em] font-medium">
              <Sparkles size={12} />
              <span>Optimized itinerary</span>
            </div>
            <div className="flex items-center gap-1.5 text-gray-600">
              <span className="text-gray-300 mr-1.5">·</span>
              <Calendar size={12} />
              <span>
                {startDate && formatDate(startDate)} – {endDate && formatDate(endDate)}
              </span>
              <span className="text-gray-500">· {totalNights} nights</span>
            </div>
            <div className="flex items-center gap-1.5 text-gray-600">
              <span className="text-gray-400 mr-1.5">·</span>
              <Users size={12} />
              <span>
                {trip.travelers} {trip.travelers === 1 ? 'traveler' : 'travelers'}
              </span>
            </div>
            <div className="flex items-center text-gray-500">
              <span className="text-gray-400 mr-3">·</span>
              {trip.cities.length} {trip.cities.length === 1 ? 'stop' : 'stops'}
            </div>
          </div>
          <TripNameEditor
            value={trip.title ?? ''}
            canRename={canRename}
            onRename={handleRename}
            onDenied={() => collab?.showToast('Only the trip owner can rename this trip', 'info')}
            placeholder="Name this trip"
            className="text-[22px] leading-tight font-semibold text-gray-900"
            inputClassName="text-[22px] leading-tight font-semibold text-gray-900 w-[380px] max-w-full"
          />
          {renameError && (
            <p className="text-[11px] mt-0.5" style={{ color: '#dc2626' }}>
              {renameError}
            </p>
          )}

          {/* Total trip + savings boxes, under the title */}
          <div className="flex items-center gap-2 mt-2">
            {/* Total cost */}
            <div
              className="flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px]"
              style={{
                background: 'linear-gradient(180deg, rgba(79,142,247,0.12) 0%, rgba(79,142,247,0.04) 100%)',
                borderColor: 'rgba(79,142,247,0.30)',
              }}
            >
              <div className="text-[#4f8ef7]/70 text-[9px] uppercase tracking-wider">
                {priceMode === 'total' ? 'Total trip' : 'Per person'}
              </div>
              <div className="text-[#4f8ef7] text-lg font-semibold leading-tight tabular-nums">
                ${animatedTotal.toLocaleString()}
              </div>
              {showToggle && (
                <div className="text-[#4f8ef7]/55 text-[9px]">
                  ${altTotal.toLocaleString()} {priceMode === 'total' ? '/person' : 'total'}
                </div>
              )}
            </div>

            {/* Savings — clickable when date-shift options exist: opens a
                menu of alternative start dates with their real, re-priced
                savings (the optimizer scored each shifted date already). */}
            {showPriceBox && (
            <div className="relative" ref={shiftMenuRef}>
              <button
                type="button"
                onClick={() => setShiftMenuOpen((v) => !v)}
                aria-expanded={shiftMenuOpen}
                aria-haspopup="dialog"
                title="See ways to save on this trip"
                className="flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px] text-left transition-all cursor-pointer hover:brightness-95"
                style={{
                  background: 'linear-gradient(180deg, rgba(52,211,153,0.08) 0%, rgba(52,211,153,0.02) 100%)',
                  borderColor: 'rgba(52,211,153,0.25)',
                }}
              >
                <div className="flex items-center gap-1 text-[#22c088]/70 text-[9px] uppercase tracking-wider">
                  {nothingToSave ? <CheckCircle2 size={9} /> : <TrendingDown size={9} />}
                  <span>{nothingToSave ? 'Price check' : 'You can save'}</span>
                  {(
                    <ChevronDown
                      size={9}
                      className={`transition-transform ${shiftMenuOpen ? 'rotate-180' : ''}`}
                    />
                  )}
                </div>
                <div className="text-[#22c088] text-lg font-semibold leading-tight tabular-nums">
                  {nothingToSave ? 'Best price' : `$${animatedSavings.toLocaleString()}`}
                </div>
                <div className="text-[#22c088]/50 text-[9px]">
                  {nothingToSave
                    ? 'for these dates'
                    : shiftIsBest
                      ? `by starting ${shiftDateNice}`
                      : // The optimizer's baseline (savingsVsNaive) is the
                        // order the traveller typed — as the AI chat says it.
                        'vs your original city order'}
                </div>
              </button>

              {shiftMenuOpen && (
                <div
                  role="dialog"
                  aria-label="Ways to save"
                  className="absolute left-0 top-full mt-2 w-[300px] max-h-[70vh] overflow-y-auto bg-white border rounded-xl shadow-lg z-50"
                  style={{ borderColor: 'rgba(52,211,153,0.35)' }}
                >
                  <div className="px-3 pt-2.5 pb-1.5 text-[10px] uppercase tracking-wider text-gray-400 font-medium">
                    Ways to save
                  </div>
                  {!shiftIsBest && liveSavings > 0 && (
                    <div className="px-3 pb-2 flex items-start gap-1.5 text-[11px] text-gray-500">
                      <CheckCircle2 size={12} className="text-[#22c088] mt-px flex-shrink-0" />
                      <span>
                        Already saving $
                        {(priceMode === 'total' ? liveSavings : Math.round(liveSavings / travelers)).toLocaleString()}{' '}
                        by visiting your cities in this order.
                      </span>
                    </div>
                  )}
                  {saveOptions.map((opt) => {
                    const amt = priceMode === 'total' ? opt.savings : Math.round(opt.savings / travelers);
                    const body = (
                      <>
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-gray-800 truncate">{opt.title}</div>
                          <div className="text-[10px] text-gray-500 truncate">{opt.detail}</div>
                        </div>
                        <div className="text-[#22c088] text-[13px] font-semibold tabular-nums flex-shrink-0">
                          save ${amt.toLocaleString()}
                        </div>
                      </>
                    );
                    const cls = 'w-full px-3 py-2 border-t border-gray-100 flex items-center justify-between gap-2 text-left';
                    return canEdit ? (
                      <button
                        type="button"
                        key={opt.id}
                        data-testid="save-option"
                        onClick={() => {
                          applySaveOption(opt);
                          setShiftMenuOpen(false);
                        }}
                        title="Switch to this"
                        className={`${cls} transition-colors hover:bg-emerald-50/60 cursor-pointer`}
                      >
                        {body}
                      </button>
                    ) : (
                      <div key={opt.id} data-testid="save-option" className={cls}>
                        {body}
                      </div>
                    );
                  })}
                  {saveOptions.length === 0 && shiftOptions.length === 0 && (
                    <div className="px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500">
                      No cheaper hotel, train or flight on this trip right now — you already have the lowest prices we found.
                    </div>
                  )}
                  {shiftOptions.length > 0 && (
                  <>
                  <div className="px-3 pt-2.5 pb-1.5 border-t border-gray-100 text-[10px] uppercase tracking-wider text-gray-400 font-medium">
                    Cheaper start dates
                  </div>
                  {shiftOptions.map((opt) => {
                    const optSavings =
                      priceMode === 'total'
                        ? Math.round(opt.savings)
                        : Math.round(opt.savings / travelers);
                    return (
                      <button
                        type="button"
                        key={opt.dayOffset}
                        onClick={() => applyDateShift(opt)}
                        title="Replan this trip starting on this date"
                        className="w-full px-3 py-2 border-t border-gray-100 flex items-center justify-between gap-2 text-left transition-colors hover:bg-emerald-50/60 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-gray-800">
                            {offsetLabel(opt.dayOffset)}
                          </div>
                          <div className="text-[10px] text-gray-500">
                            starts {niceFullDate(opt.newStartDate)}
                          </div>
                        </div>
                        <div className="text-[#22c088] text-[13px] font-semibold tabular-nums flex-shrink-0">
                          save ${optSavings.toLocaleString()}
                        </div>
                      </button>
                    );
                  })}
                  <div className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">
                    Picking a date replans your trip with live prices — the
                    final savings can differ slightly.
                  </div>
                  </>
                  )}
                </div>
              )}
            </div>
            )}

            {showToggle && (
              <div
                className="flex items-center p-0.5 rounded-full border bg-white/80"
                style={{ borderColor: 'rgba(79,142,247,0.25)' }}
                role="tablist"
                aria-label="Price view"
              >
                <button
                  role="tab"
                  aria-selected={priceMode === 'total'}
                  onClick={() => setPriceMode('total')}
                  className="px-2 py-0.5 text-[9px] font-medium rounded-full transition-colors"
                  style={{
                    background: priceMode === 'total' ? '#4f8ef7' : 'transparent',
                    color: priceMode === 'total' ? '#ffffff' : '#4f8ef7',
                  }}
                >
                  Total
                </button>
                <button
                  role="tab"
                  aria-selected={priceMode === 'perPerson'}
                  onClick={() => setPriceMode('perPerson')}
                  className="px-2 py-0.5 text-[9px] font-medium rounded-full transition-colors"
                  style={{
                    background: priceMode === 'perPerson' ? '#4f8ef7' : 'transparent',
                    color: priceMode === 'perPerson' ? '#ffffff' : '#4f8ef7',
                  }}
                >
                  Per person
                </button>
              </div>
            )}

          </div>
        </div>

        {/* Right: collaborators + Share (and, for collaborators, their own
            actions). Share replaces "Edit in Canvas": the results page is
            the canvas now. */}
        <div className="flex items-center gap-2.5 flex-shrink-0 pt-1">
          {collab?.active && trip.id && (
            <CollaboratorAvatars
              tripId={trip.id}
              presence={collab.presence}
              selfId={collab.self?.id ?? null}
              refreshKey={membersKey}
              onClick={canShare ? handleShare : undefined}
            />
          )}

          {role === 'viewer' && (
            <span
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] text-gray-500 bg-white/80 border border-gray-200"
              title="The owner shared this trip with you to view"
            >
              <Eye size={11} />
              View only
            </span>
          )}

          {role === 'suggester' && collab?.hasLocalChanges && (
            <>
              <button
                onClick={collab.discard}
                disabled={collab.busy}
                title="Throw away your changes"
                className="px-3 py-2 rounded-xl text-[12px] font-medium text-gray-500 border border-gray-200 bg-white transition-all hover:bg-gray-50 hover:text-gray-700 disabled:opacity-40"
              >
                Discard
              </button>
              <button
                onClick={collab.propose}
                disabled={collab.busy}
                title="Your changes go to the owner for approval"
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                style={{ background: '#2563eb' }}
              >
                <Send size={13} />
                {collab.busy ? 'Sending…' : 'Propose changes'}
              </button>
            </>
          )}

          {(role === 'editor' || role === 'suggester') && (
            <button
              onClick={collab?.saveCopy}
              disabled={collab?.busy}
              title="Save the trip as it is now to your own trips — the shared trip is untouched"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[12px] font-medium transition-all hover:bg-blue-50 disabled:opacity-40"
              style={{ color: '#2563eb', borderColor: '#2563eb', background: '#ffffff' }}
            >
              <Copy size={13} />
              Save a copy
            </button>
          )}

          {canShare && (
            <button
              onClick={handleShare}
              disabled={saving}
              data-testid="share-button"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-60"
              style={{ background: '#2563eb', borderColor: '#2563eb' }}
            >
              <Share2 size={13} />
              {saving ? 'Saving...' : 'Share'}
            </button>
          )}
        </div>
      </div>

      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  );
}
