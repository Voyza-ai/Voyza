'use client';

import { useTripStore, restoreTripSession } from '@/store/tripStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, UserX, WifiOff } from 'lucide-react';
import Navbar from '@/components/shared/Navbar';
import ResultsHeader from '@/components/results/ResultsHeader';
import OriginClarification, { type OriginChoice } from '@/components/results/OriginClarification';
import Flowchart from '@/components/results/Flowchart';
import CalendarView from '@/components/results/CalendarView';
import ScheduleView from '@/components/results/ScheduleView';
import ViewTabs, { ResultsView } from '@/components/results/ViewTabs';
import dynamic from 'next/dynamic';

// Leaflet touches `window` at import time — load the map client-side only.
const MapView = dynamic(() => import('@/components/results/MapView'), { ssr: false });
import AIChatPanel from '@/components/results/AIChatPanel';
import { countryForCity } from '@/data/worldCities';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import ActivitiesDetailPanel from '@/components/results/ActivitiesDetailPanel';
import BudgetOverBanner from '@/components/results/BudgetOverBanner';
import NoRailDataNotice from '@/components/results/NoRailDataNotice';
import VibeTierUpBanner from '@/components/results/VibeTierUpBanner';
import { searchHotels, fetchHomeLegs, updateTrip, compareLeg, type LegComparison } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import { hotelFromResult, rerankSavedCityHotels } from '@/lib/hotelShape';
import { originAirportsForCity } from '@/lib/locationResolver';
import { Hotel, City, Transport, HomeLeg, Trip } from '@/lib/types';
import { tripStartDate, addDaysIso, daysFrom } from '@/lib/tripSpan';
import { formatMinutes } from '@/lib/dateHelpers';
import { useAuthStore } from '@/store/authStore';
import { useSavedTripAutosave, useSavedTripUnsaved } from '@/lib/useSavedTripAutosave';
import { useLeaveGuard, type LeaveGuardCopy } from '@/lib/leaveGuard';
import { requestPicksForAddedCity } from '@/store/tripStore';
import { useTripCollaboration } from '@/hooks/useTripCollaboration';
import { isApplyingRemote, remoteAppliedWithin, rechainDates, staleLegIndices } from '@/lib/tripCollab';
import { nextColorIndex } from '@/lib/cityColors';
import ShareModal from '@/components/canvas/ShareModal';
import AddCityModal from '@/components/canvas/AddCityModal';
import HomeEditModal from '@/components/canvas/HomeEditModal';
import SuggestedCitiesPanel from '@/components/canvas/SuggestedCitiesPanel';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';
import LoginModal from '@/components/shared/LoginModal';
import { useNotificationsStore } from '@/store/notificationsStore';

import { useResultsController } from '@/components/results/useResultsController';

// Next.js 14 requires useSearchParams() to be wrapped in a <Suspense> boundary
// during the static build pass. We split the page into an outer wrapper that
// provides the boundary and an inner component that actually uses the hook.
export default function ResultsPage() {
  return (
    <Suspense fallback={null}>
      <ResultsPageInner />
    </Suspense>
  );
}

function ResultsPageInner() {
  const {
    currentTrip,
    setTrip,
    router,
    searchParams,
    tripId,
    view,
    setView,
    openCityIndex,
    setOpenCityIndex,
    openActivitiesIndex,
    setOpenActivitiesIndex,
    loading,
    error,
    isAuthLoading,
    user,
    collab,
    chatOpen,
    setChatOpen,
    shareOpen,
    setShareOpen,
    membersKey,
    setMembersKey,
    addingAfter,
    setAddingAfter,
    homeEdit,
    setHomeEdit,
    refreshingLegs,
    frozenTrip,
    homeLegSearch,
    chooseOrigin,
    reorderCities,
    removeCity,
    addCity,
    setCityNights,
    applyHomeEdit,
    cardsAreaRef,
    onCardsMouseMove,
    cursors,
    signInModal,
    accessGate,
    updateCity,
  } = useResultsController();

  if (tripId && !isAuthLoading && !user) {
    return (
      <main className="h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <p className="text-gray-500 text-sm">Sign in to open this trip</p>
        {signInModal}
      </main>
    );
  }

  if (collab.accessGate) {
    // The navbar stays (with its notification bell): a removed person who is
    // invited again sees it arrive here instead of having to go elsewhere.
    return (
      <main className="h-screen flex flex-col" style={{ background: '#f0f4f8' }}>
        <Navbar />
        {accessGate}
      </main>
    );
  }

  if (loading) {
    return (
      <main className="h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-500 text-sm">Loading your trip...</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <div className="text-center">
          <p className="text-red-500 text-sm mb-2">{error}</p>
          <button onClick={() => router.push('/plan')} className="text-[#2563eb] text-sm underline">
            Back to planning
          </button>
        </div>
      </main>
    );
  }

  if (!currentTrip) return null;

  // What the header prices: the trip as it last stood while a re-price is in
  // flight (see frozenTrip), else the trip itself.
  const pricedTrip = frozenTrip ?? currentTrip;

  const handleCityClick = (cityIndex: number) => {
    setOpenCityIndex(cityIndex);
    setOpenActivitiesIndex(null);
  };

  const handleActivitiesClick = (cityIndex: number) => {
    setOpenActivitiesIndex(cityIndex);
    setOpenCityIndex(null);
  };

  // What this person may change. An unsaved trip — or a saved one whose role
  // is still loading for its signed-in owner — is their own to edit.
  const editable = !collab.active || collab.canManipulate;
  const chatAllowed = !collab.active || collab.role !== 'viewer';

  return (
    <main className="h-screen overflow-hidden dot-grid-bg text-gray-900 flex flex-col">
      {/* View tabs live in the navbar (next to the auth corner) so the cards
          below get the full viewport height. The date-shift savings tip now
          arrives as a BlueMurr AI chat message instead of a page banner. */}
      <Navbar tabs={<ViewTabs value={view} onChange={setView} />} />

      {/* Page body fills the viewport below the navbar. Nothing here scrolls
          except the cards area (left↔right) and the AI chat panel. */}
      {/* Near-zero side gutters: no max-width cap, minimal padding — the
          cards start at the left edge and the chat ends at the right edge. */}
      {/* When the trip is editable the left edge holds the "Suggested Cities"
          pull-out tab, so the content starts just clear of it. */}
      <div className={`flex-1 min-h-0 flex flex-col md:flex-row gap-3 pb-2 pt-[3rem] w-full ${editable ? 'pl-9' : 'pl-2'} ${chatAllowed && !chatOpen ? 'pr-9' : 'pr-2'}`}>
        {/* Main column — header pinned, cards fill the rest */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <ResultsHeader
            trip={currentTrip}
            pricedTrip={frozenTrip ?? undefined}
            collab={collab}
            onOpenShare={() => setShareOpen(true)}
            membersKey={membersKey}
            canEdit={editable}
          />
          <AnimatePresence>
            {collab.connectionLost && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mx-4 mt-2 flex items-center justify-center gap-2 py-1.5 rounded-lg text-[12px] text-amber-700" style={{ background: '#fffbeb' }}>
                  <WifiOff size={12} />
                  Connection lost — reconnecting automatically…
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {typeof currentTrip.budget === 'number' && (
            // The total the header shows, not the stored totalCost: that is
            // set once (at creation, or a preset's quote on save) and does
            // not follow a hotel or transport swap.
            <BudgetOverBanner budget={currentTrip.budget} totalCost={liveTripTotal(pricedTrip)} />
          )}
          <NoRailDataNotice trip={currentTrip} />
          {currentTrip.vibeTierUp && (
            <VibeTierUpBanner tierUp={currentTrip.vibeTierUp} />
          )}
          {currentTrip.originClarification && currentTrip.origin && (
            <OriginClarification
              clarification={currentTrip.originClarification}
              pricedFrom={currentTrip.origin.airports ?? []}
              onChoose={chooseOrigin}
            />
          )}

          {/* Full-height cards area */}
          <div
            ref={cardsAreaRef}
            onMouseMove={onCardsMouseMove}
            className="relative flex-1 min-h-0 overflow-hidden"
          >
            {/* Collaborators' pointers */}
            {Object.keys(cursors).length > 0 && (
              <div className="pointer-events-none absolute inset-0 z-30" aria-hidden>
                {Object.entries(cursors).map(([actor, c]) => {
                  let hash = 0;
                  for (let i = 0; i < actor.length; i++) hash = (hash * 31 + actor.charCodeAt(i)) | 0;
                  const hue = Math.abs(hash) % 360;
                  return (
                    <div key={actor} className="absolute transition-all duration-75 ease-linear" style={{ left: c.x, top: c.y }}>
                      <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
                        <path d="M1 1 L15 8.5 L8.5 10 L5.5 17 Z" fill={`hsl(${hue}, 65%, 50%)`} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
                      </svg>
                      <span
                        className="ml-3 -mt-0.5 inline-block px-1.5 py-0.5 rounded-md text-[10px] font-medium text-white whitespace-nowrap"
                        style={{ background: `hsl(${hue}, 65%, 45%)` }}
                      >
                        {c.name ?? 'Someone'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {openCityIndex !== null ? (
              <CityDetailPanel
                trip={currentTrip}
                cityIndex={openCityIndex}
                onClose={() => setOpenCityIndex(null)}
                onPrev={() =>
                  setOpenCityIndex((i) => (i !== null && i > 0 ? i - 1 : i))
                }
                onNext={() =>
                  setOpenCityIndex((i) =>
                    i !== null && i < currentTrip.cities.length - 1 ? i + 1 : i
                  )
                }
              />
            ) : openActivitiesIndex !== null ? (
              <ActivitiesDetailPanel
                trip={currentTrip}
                cityIndex={openActivitiesIndex}
                onClose={() => setOpenActivitiesIndex(null)}
                onPrev={() =>
                  setOpenActivitiesIndex((i) => (i !== null && i > 0 ? i - 1 : i))
                }
                onNext={() =>
                  setOpenActivitiesIndex((i) =>
                    i !== null && i < currentTrip.cities.length - 1 ? i + 1 : i
                  )
                }
              />
            ) : view === 'flowchart' ? (
              <Flowchart
                trip={currentTrip}
                onCityClick={handleCityClick}
                onActivitiesClick={handleActivitiesClick}
                homeLegSearch={homeLegSearch}
                editable={editable}
                onReorder={reorderCities}
                onRemoveCity={removeCity}
                onNightsChange={setCityNights}
                onAddCityAfter={(i) => setAddingAfter(i)}
                onEditHome={(d) => setHomeEdit(d)}
                refreshingLegs={refreshingLegs}
              />
            ) : view === 'schedule' ? (
              <div className="h-full min-h-0">
                <ScheduleView trip={currentTrip} />
              </div>
            ) : view === 'map' ? (
              <MapView trip={currentTrip} />
            ) : (
              <div className="h-full overflow-y-auto">
                <CalendarView trip={currentTrip} onCityClick={handleCityClick} />
              </div>
            )}
          </div>
        </div>

        {/* AI chat sidebar. Docks to the right from `md` up (not `lg`) so it
            matches the canvas on ordinary laptop windows — at the old
            breakpoint anything under 1024px dropped the chat below the
            content, which read as a different layout from the rest of the app. */}
        {/* Stacked on mobile, the chat has no width to be bounded by, so it
            grew to its natural height and left the content above it a sliver —
            the Map tab came out 77px tall, most of that covered by the tile
            attribution. Cap it below `md` so the content above always keeps
            the larger share; from `md` up it docks to the right and the cap
            is irrelevant. */}
        {/* Hidden, it stays mounted (the conversation is kept) and the cards
            take the width; a tab on the right edge brings it back. */}
        {chatAllowed && (
          <aside
            className={`max-h-[45vh] md:max-h-none md:w-[340px] lg:w-[380px] md:flex-shrink-0 min-h-0 md:mt-3 ${chatOpen ? 'flex' : 'hidden'}`}
          >
            <AIChatPanel trip={currentTrip} onHide={() => setChatOpen(false)} />
          </aside>
        )}
      </div>

      {/* BlueMurr AI pull-out tab — the right-edge twin of "Suggested Cities". */}
      <AnimatePresence>
        {chatAllowed && !chatOpen && (
          <motion.button
            initial={{ x: 48 }}
            animate={{ x: 0 }}
            exit={{ x: 48 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            onClick={() => setChatOpen(true)}
            aria-label="Show BlueMurr AI"
            className="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1.5 rounded-l-xl py-3.5 px-1.5 shadow-md hover:shadow-lg transition-shadow"
            style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.08)', borderRight: 'none' }}
          >
            <Sparkles size={13} style={{ color: '#2563eb' }} />
            <span className="text-[10px] font-medium text-gray-600 tracking-wide" style={{ writingMode: 'vertical-rl' }}>
              BlueMurr AI
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* ─── From the canvas: suggested cities, pending suggestions,
          add-city / home-airport editors, the share dialog ─── */}
      {editable && (
        <SuggestedCitiesPanel
          tripId={currentTrip.id ?? ''}
          currentCities={currentTrip.cities.map((c) => c.name)}
          budget={currentTrip.budget}
          role={collab.active ? (collab.role ?? 'viewer') : 'owner'}
          onAddCity={(dest) => addCity(currentTrip.cities.length - 1, { name: dest.name, nights: 2 })}
          onSuggestCity={collab.suggestCity}
        />
      )}
      {collab.active && collab.role && (
        <SuggestionsPanel
          suggestions={collab.suggestions}
          role={collab.role}
          onApprove={(id) =>
            collab.approve(id, (name) =>
              addCity((useTripStore.getState().currentTrip?.cities.length ?? 1) - 1, { name, nights: 2 }),
            )
          }
          onReject={collab.reject}
        />
      )}
      <AddCityModal
        isOpen={addingAfter !== null}
        onClose={() => setAddingAfter(null)}
        onAdd={(data) => {
          const after = addingAfter ?? currentTrip.cities.length - 1;
          setAddingAfter(null);
          addCity(after, data);
        }}
        currentCities={currentTrip.cities.map((c) => c.name)}
      />
      <HomeEditModal
        isOpen={homeEdit !== null}
        direction={homeEdit ?? 'outbound'}
        city={
          homeEdit === 'inbound'
            ? currentTrip.origin?.returnCity ?? currentTrip.origin?.city ?? ''
            : currentTrip.origin?.city ?? ''
        }
        airports={
          homeEdit === 'inbound'
            ? currentTrip.origin?.returnAirports ?? currentTrip.origin?.airports ?? []
            : currentTrip.origin?.airports ?? []
        }
        onClose={() => setHomeEdit(null)}
        onApply={(updates) => homeEdit && applyHomeEdit(homeEdit, updates)}
      />
      {currentTrip.id && !currentTrip.id.startsWith('mock') && (
        <ShareModal
          tripId={currentTrip.id}
          role={collab.role ?? 'owner'}
          isOpen={shareOpen}
          onClose={() => {
            setShareOpen(false);
            setMembersKey((k) => k + 1);
          }}
          onToast={collab.showToast}
          onRoleChanged={(target, role) => {
            collab.broadcastRoleChange(target, role);
            setMembersKey((k) => k + 1);
          }}
          onTransferred={collab.onTransferred}
        />
      )}

      {/* ─── Toast ─── */}
      <AnimatePresence>
        {collab.toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full text-[13px] font-medium shadow-lg"
            style={{
              background:
                collab.toast.type === 'success'
                  ? 'rgba(34,192,136,0.95)'
                  : collab.toast.type === 'error'
                    ? 'rgba(220,38,38,0.95)'
                    : 'rgba(37,99,235,0.95)',
              color: '#ffffff',
            }}
            role="status"
          >
            {collab.toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
