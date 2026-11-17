'use client';

import { useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Share2, Sparkles, TrendingDown, Calendar as CalendarIcon, Users, WifiOff, Eye, Send, Copy, SlidersHorizontal, Save } from 'lucide-react';
import { useResultsController, type ResultsController } from '@/components/results/useResultsController';
import { useResultsHeader } from '@/components/results/useResultsHeader';
import CalendarView from '@/components/results/CalendarView';
import ScheduleView from '@/components/results/ScheduleView';
import BudgetOverBanner from '@/components/results/BudgetOverBanner';
import NoRailDataNotice from '@/components/results/NoRailDataNotice';
import VibeTierUpBanner from '@/components/results/VibeTierUpBanner';
import OriginClarification from '@/components/results/OriginClarification';
import ShareModal from '@/components/canvas/ShareModal';
import AddCityModal from '@/components/canvas/AddCityModal';
import HomeEditModal from '@/components/canvas/HomeEditModal';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';
import LoginModal from '@/components/shared/LoginModal';
import TripNameEditor from '@/components/shared/TripNameEditor';
import { liveTripTotal } from '@/lib/tripTotals';
import { humanDay } from '@/lib/dateHelpers';
import { useTripStore } from '@/store/tripStore';
import MobileItinerary, { type LegRef } from './MobileItinerary';
import LegSheet from './LegSheet';
import CitySheet from './CitySheet';
import ChatSheet from './ChatSheet';
import BottomSheet from './BottomSheet';
import { M } from './theme';

const MapView = dynamic(() => import('@/components/results/MapView'), { ssr: false });

export const MOBILE_RESULTS_PATHS = { plan: '/m/plan', hub: '/m', trips: '/m/trips' };
export const MOBILE_HEADER_PATHS = { results: '/m/trip', plan: '/m/plan' };

type Tab = 'itinerary' | 'calendar' | 'schedule' | 'map';
const TABS: Array<[Tab, string]> = [
  ['itinerary', 'Itinerary'],
  ['calendar', 'Calendar'],
  ['schedule', 'Schedule'],
  ['map', 'Map'],
];

/**
 * The trip on a phone. Everything it does is the desktop results page's own
 * logic (useResultsController + useResultsHeader): loading a saved trip,
 * re-pricing after changes, home-flight backfill, add / move / remove city,
 * autosave of a saved trip, the leave-without-saving guard, sharing and
 * collaboration. Only the layout is new.
 *
 * `demo` (the /m/demo route) turns off the actions that would need an
 * account or a booking — the trip itself is still fully interactive.
 */
export default function MobileTrip({ demo = false }: { demo?: boolean }) {
  const c = useResultsController(MOBILE_RESULTS_PATHS);

  if (c.tripId && !c.isAuthLoading && !c.user) {
    return (
      <main className="fixed inset-0 flex items-center justify-center" style={{ background: M.bg }}>
        <p className="text-gray-500 text-[15px]">Sign in to open this trip</p>
        {c.signInModal}
      </main>
    );
  }
  if (c.collab.accessGate) {
    return (
      <main className="fixed inset-0 flex flex-col" style={{ background: M.bg }}>
        {c.accessGate}
      </main>
    );
  }
  if (c.loading) {
    return (
      <main className="fixed inset-0 flex flex-col items-center justify-center gap-3" style={{ background: M.bg }}>
        <div className="w-8 h-8 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-500 text-[15px]">Loading your trip…</p>
      </main>
    );
  }
  if (c.error) {
    return (
      <main className="fixed inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: M.bg }}>
        <p className="text-red-500 text-[15px]">{c.error}</p>
        <Link href="/m/plan" className="min-h-[44px] px-5 flex items-center rounded-full text-white" style={{ background: M.blue }}>
          Back to planning
        </Link>
      </main>
    );
  }
  if (!c.currentTrip) return null;
  return <TripScreen c={c} demo={demo} />;
}

function TripScreen({ c, demo }: { c: ResultsController; demo: boolean }) {
  const trip = c.currentTrip!;
  const editable = !c.collab.active || c.collab.canManipulate;
  const chatAllowed = !c.collab.active || c.collab.role !== 'viewer';
  const h = useResultsHeader(
    {
      trip,
      pricedTrip: c.frozenTrip ?? undefined,
      collab: c.collab,
      onOpenShare: () => c.setShareOpen(true),
      membersKey: c.membersKey,
      canEdit: editable,
    },
    MOBILE_HEADER_PATHS,
  );

  const [tab, setTab] = useState<Tab>('itinerary');
  const [leg, setLeg] = useState<LegRef | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [savingsOpen, setSavingsOpen] = useState(false);
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const priceMode = useTripStore((s) => s.priceMode);

  const pricedTrip = c.frozenTrip ?? trip;
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const unit = priceMode === 'perPerson' && trip.travelers > 1 ? '/person' : '';

  const move = (from: number, to: number) => {
    if (to < 0 || to >= trip.cities.length) return;
    const order = [...trip.cities];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    c.reorderCities(order);
    c.setOpenCityIndex(to);
  };

  const demoOnly = (what: string) => setDemoNote(`${what} is turned off in the demo — open the real app to use it.`);
  const backHref = trip.id && !trip.id.startsWith('mock') ? '/m/trips' : '/m';

  return (
    <main className="fixed inset-0 flex flex-col" style={{ background: M.bg }} data-testid="m-trip">
      {/* ── Header ── */}
      <header className="flex-shrink-0 bg-white border-b" style={{ borderColor: M.line, paddingTop: 'max(6px, env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-1 px-2">
          <Link href={demo ? '/m' : backHref} aria-label="Back" className="w-11 h-11 rounded-full flex items-center justify-center text-gray-700 active:bg-gray-100 flex-shrink-0">
            <ArrowLeft size={22} />
          </Link>
          <div className="flex-1 min-w-0">
            <TripNameEditor
              value={trip.title ?? ''}
              canRename={h.canRename && !demo}
              onRename={h.handleRename}
              onDenied={() => (demo ? demoOnly('Renaming') : c.collab.showToast('Only the trip owner can rename this trip', 'info'))}
              placeholder="Name this trip"
              className="text-[18px] leading-tight font-semibold text-gray-900 truncate block max-w-full"
              inputClassName="text-[18px] leading-tight font-semibold text-gray-900 w-full"
            />
          </div>
          {h.role === 'viewer' && (
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] text-gray-500 border border-gray-200">
              <Eye size={12} /> View only
            </span>
          )}
          {!h.alreadySaved && !c.collab.active && (
            <button
              onClick={() => (demo ? demoOnly('Saving') : h.requestSave(false))}
              disabled={h.saving}
              className="min-h-[40px] px-3 flex items-center gap-1.5 rounded-full border text-[14px] font-medium disabled:opacity-50"
              style={{ borderColor: M.blue, color: M.blue }}
              data-testid="m-save"
            >
              <Save size={15} /> {h.saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {h.canShare && (
            <button
              onClick={() => (demo ? demoOnly('Sharing') : h.handleShare())}
              disabled={h.saving}
              aria-label="Share trip"
              className="w-11 h-11 rounded-full flex items-center justify-center text-white flex-shrink-0 disabled:opacity-50"
              style={{ background: M.blue }}
              data-testid="m-share"
            >
              <Share2 size={18} />
            </button>
          )}
        </div>
        {h.renameError && <p className="px-14 text-[12px] text-red-600">{h.renameError}</p>}

        <div className="flex items-center gap-3 px-4 pt-1 text-[13px] text-gray-500">
          <span className="flex items-center gap-1">
            <CalendarIcon size={13} />
            {h.startDate && h.endDate ? `${humanDay(h.startDate)} – ${humanDay(h.endDate)}` : 'Dates to come'}
          </span>
          <span className="flex items-center gap-1">
            <Users size={13} />
            {trip.travelers}
          </span>
          <span>{trip.cities.length} {trip.cities.length === 1 ? 'stop' : 'stops'}</span>
        </div>

        <div className="flex items-stretch gap-2 px-4 pt-2 pb-3">
          <button
            onClick={() => h.showToggle && h.setPriceMode(priceMode === 'total' ? 'perPerson' : 'total')}
            className="flex-1 min-h-[52px] flex flex-col justify-center items-start px-3 rounded-2xl border text-left"
            style={{ borderColor: M.line }}
            aria-label={h.showToggle ? 'Switch between total and per-person prices' : 'Trip total'}
            data-testid="m-total"
          >
            <span className="text-[11px] uppercase tracking-wider text-gray-500">
              {priceMode === 'total' ? 'Trip total' : 'Per person'}
              {h.showToggle && <span className="normal-case tracking-normal text-[#2563eb]"> · tap to switch</span>}
            </span>
            <span className="text-[20px] font-bold tabular-nums text-gray-900 leading-tight">
              {money(h.animatedTotal)}
              {h.showToggle && (
                <span className="text-[12px] font-medium text-gray-500 ml-1.5">
                  ({money(h.altTotal)} {priceMode === 'total' ? 'pp' : 'total'})
                </span>
              )}
            </span>
          </button>
          {h.showPriceBox && (
            <button
              onClick={() => setSavingsOpen(true)}
              className="min-h-[52px] flex flex-col justify-center items-start px-3 rounded-2xl border text-left"
              style={{ borderColor: '#a7f3d0', background: '#ecfdf5' }}
              data-testid="m-savings"
            >
              <span className="text-[11px] uppercase tracking-wider text-emerald-700 flex items-center gap-1">
                <TrendingDown size={12} /> {h.nothingToSave ? 'Best price' : 'You can save'}
              </span>
              <span className="text-[17px] font-bold tabular-nums text-emerald-700 leading-tight">
                {h.nothingToSave ? 'for these dates' : `${money(h.animatedSavings)}${unit}`}
              </span>
            </button>
          )}
        </div>

        {/* Collaborator actions */}
        {(h.role === 'suggester' && c.collab.hasLocalChanges) || h.role === 'editor' || h.role === 'suggester' ? (
          <div className="flex gap-2 px-4 pb-3">
            {h.role === 'suggester' && c.collab.hasLocalChanges && (
              <>
                <button onClick={c.collab.discard} disabled={c.collab.busy} className="flex-1 min-h-[44px] rounded-xl border text-[14px] text-gray-600" style={{ borderColor: M.line }}>
                  Discard
                </button>
                <button onClick={c.collab.propose} disabled={c.collab.busy} className="flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-xl text-[14px] text-white" style={{ background: M.blue }}>
                  <Send size={14} /> {c.collab.busy ? 'Sending…' : 'Propose changes'}
                </button>
              </>
            )}
            {(h.role === 'editor' || h.role === 'suggester') && (
              <button onClick={c.collab.saveCopy} disabled={c.collab.busy} className="flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-xl border text-[14px]" style={{ borderColor: M.blue, color: M.blue }}>
                <Copy size={14} /> Save a copy
              </button>
            )}
          </div>
        ) : null}

        {/* Segmented control — the four views of the trip */}
        <div className="px-4 pb-2.5">
          <div className="grid grid-cols-4 p-1 rounded-xl bg-gray-100" role="tablist" aria-label="Trip views">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`min-h-[36px] rounded-lg text-[13px] font-medium transition-colors ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {demo && (
        <div className="flex-shrink-0 text-center text-[12px] py-1.5 text-white/85" style={{ background: M.ai }} data-testid="m-demo-ribbon">
          Demo trip · sample data · nothing is saved
        </div>
      )}

      <AnimatePresence>
        {c.collab.connectionLost && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden flex-shrink-0">
            <div className="flex items-center justify-center gap-2 py-1.5 text-[12px] text-amber-700" style={{ background: '#fffbeb' }}>
              <WifiOff size={12} /> Connection lost — reconnecting…
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Body ── */}
      <div className={`flex-1 min-h-0 ${tab === 'schedule' || tab === 'map' ? 'flex flex-col' : 'overflow-y-auto'}`} data-testid={`m-view-${tab}`}>
        {tab === 'itinerary' || tab === 'calendar' ? (
          <div className="px-4 pt-3 flex flex-col gap-2 empty:hidden">
            {typeof trip.budget === 'number' && <BudgetOverBanner budget={trip.budget} totalCost={liveTripTotal(pricedTrip)} />}
            <NoRailDataNotice trip={trip} />
            {trip.vibeTierUp && <VibeTierUpBanner tierUp={trip.vibeTierUp} />}
            {trip.originClarification && trip.origin && (
              <OriginClarification clarification={trip.originClarification} pricedFrom={trip.origin.airports ?? []} onChoose={c.chooseOrigin} />
            )}
          </div>
        ) : null}

        {tab === 'itinerary' && (
          <div className="pb-28">
            <MobileItinerary
              trip={trip}
              editable={editable}
              homeLegSearch={c.homeLegSearch}
              refreshingLegs={c.refreshingLegs}
              onOpenCity={(i) => c.setOpenCityIndex(i)}
              onOpenLeg={setLeg}
              onNightsChange={c.setCityNights}
              onAddCity={() => c.setAddingAfter(trip.cities.length - 1)}
              onEditHome={(d) => c.setHomeEdit(d)}
            />
            {!demo && (
              <div className="px-4">
                <Link
                  href="/m/plan?resume=1"
                  className="min-h-[48px] flex items-center justify-center gap-2 rounded-2xl border bg-white text-[15px] text-gray-700"
                  style={{ borderColor: M.line }}
                >
                  <SlidersHorizontal size={16} /> Adjust trip in the planner
                </Link>
              </div>
            )}
          </div>
        )}
        {tab === 'calendar' && (
          <div className="m-calendar px-2 pt-2 pb-28">
            <CalendarView trip={trip} onCityClick={(i) => c.setOpenCityIndex(i)} />
          </div>
        )}
        {tab === 'schedule' && (
          <div className="m-schedule flex-1 min-h-0 pb-24">
            <ScheduleView trip={trip} />
          </div>
        )}
        {tab === 'map' && (
          <div className="m-map flex-1 min-h-0 relative">
            <MapView trip={trip} />
          </div>
        )}
      </div>

      {/* ── BlueMurr AI: thumb-reachable, bottom centre ── */}
      {chatAllowed && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center px-4" style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}>
          <button
            onClick={() => setChatOpen(true)}
            className="pointer-events-auto min-h-[52px] px-6 flex items-center gap-2.5 rounded-full text-white text-[16px] font-medium shadow-[0_6px_20px_rgba(15,15,26,0.35)] active:scale-[0.98]"
            style={{ background: M.ai }}
            data-testid="m-ask-ai"
          >
            <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: M.blue }}>
              <Sparkles size={14} />
            </span>
            Ask BlueMurr AI
          </button>
        </div>
      )}

      {/* ── Sheets ── */}
      <CitySheet
        trip={trip}
        index={c.openCityIndex}
        onClose={() => c.setOpenCityIndex(null)}
        onIndexChange={(i) => c.setOpenCityIndex(i)}
        editable={editable}
        onMove={move}
        onRemove={(i) => {
          c.setOpenCityIndex(null);
          c.removeCity(i);
        }}
      />
      <LegSheet trip={trip} leg={leg} onClose={() => setLeg(null)} editable={editable} bookingDisabled={demo} />
      {chatAllowed && <ChatSheet trip={trip} open={chatOpen} onClose={() => setChatOpen(false)} />}

      <BottomSheet open={savingsOpen} onClose={() => setSavingsOpen(false)} title="Ways to save" testId="m-savings-sheet">
        <div className="px-5 pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-2">
          {h.saveOptions.map((opt) => {
            const amt = priceMode === 'total' ? opt.savings : Math.round(opt.savings / h.travelers);
            return (
              <button
                key={opt.id}
                disabled={!editable}
                onClick={() => {
                  h.applySaveOption(opt);
                  setSavingsOpen(false);
                }}
                className="min-h-[60px] flex items-center gap-3 rounded-2xl border px-4 py-2 text-left disabled:opacity-70"
                style={{ borderColor: M.line }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-medium text-gray-900">{opt.title}</div>
                  <div className="text-[12px] text-gray-500">{opt.detail}</div>
                </div>
                <span className="text-[15px] font-bold text-emerald-700 tabular-nums">−{money(amt)}</span>
              </button>
            );
          })}
          {h.shiftOptions.length > 0 && <div className="mt-2 text-[13px] font-semibold text-gray-500 uppercase tracking-wide">Shift your dates</div>}
          {h.shiftOptions.map((opt) => {
            const amt = priceMode === 'total' ? Math.round(opt.savings) : Math.round(opt.savings / h.travelers);
            return (
              <button
                key={opt.dayOffset}
                onClick={() => (demo ? demoOnly('Re-planning') : h.applyDateShift(opt))}
                className="min-h-[60px] flex items-center gap-3 rounded-2xl border px-4 py-2 text-left"
                style={{ borderColor: M.line }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-medium text-gray-900">{h.offsetLabel(opt.dayOffset)}</div>
                  <div className="text-[12px] text-gray-500">starts {h.niceFullDate(opt.newStartDate)}</div>
                </div>
                <span className="text-[15px] font-bold text-emerald-700 tabular-nums">−{money(amt)}</span>
              </button>
            );
          })}
          {h.saveOptions.length === 0 && h.shiftOptions.length === 0 && (
            <p className="text-[15px] text-gray-600 pb-2">This is already the best price we found for these dates.</p>
          )}
        </div>
      </BottomSheet>

      {/* ── The desktop's own dialogs ── */}
      {c.collab.active && c.collab.role && (
        <SuggestionsPanel
          suggestions={c.collab.suggestions}
          role={c.collab.role}
          onApprove={(id) =>
            c.collab.approve(id, (name) => c.addCity((useTripStore.getState().currentTrip?.cities.length ?? 1) - 1, { name, nights: 2 }))
          }
          onReject={c.collab.reject}
        />
      )}
      <AddCityModal
        isOpen={c.addingAfter !== null}
        onClose={() => c.setAddingAfter(null)}
        onAdd={(data) => {
          const after = c.addingAfter ?? trip.cities.length - 1;
          c.setAddingAfter(null);
          c.addCity(after, data);
        }}
        currentCities={trip.cities.map((x) => x.name)}
      />
      <HomeEditModal
        isOpen={c.homeEdit !== null}
        direction={c.homeEdit ?? 'outbound'}
        city={c.homeEdit === 'inbound' ? trip.origin?.returnCity ?? trip.origin?.city ?? '' : trip.origin?.city ?? ''}
        airports={c.homeEdit === 'inbound' ? trip.origin?.returnAirports ?? trip.origin?.airports ?? [] : trip.origin?.airports ?? []}
        onClose={() => c.setHomeEdit(null)}
        onApply={(updates) => c.homeEdit && c.applyHomeEdit(c.homeEdit, updates)}
      />
      {trip.id && !trip.id.startsWith('mock') && !demo && (
        <ShareModal
          tripId={trip.id}
          role={c.collab.role ?? 'owner'}
          isOpen={c.shareOpen}
          onClose={() => {
            c.setShareOpen(false);
            c.setMembersKey((k) => k + 1);
          }}
          onToast={c.collab.showToast}
          onRoleChanged={(target, role) => {
            c.collab.broadcastRoleChange(target, role);
            c.setMembersKey((k) => k + 1);
          }}
          onTransferred={c.collab.onTransferred}
        />
      )}
      <LoginModal isOpen={h.showLoginModal} onClose={() => h.setShowLoginModal(false)} onSuccess={h.handleLoginSuccess} />

      <AnimatePresence>
        {(c.collab.toast || demoNote) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            onAnimationComplete={() => demoNote && setTimeout(() => setDemoNote(null), 2600)}
            className="fixed left-4 right-4 z-[58] px-4 py-3 rounded-2xl text-[14px] font-medium text-white text-center"
            style={{
              bottom: 'calc(max(14px, env(safe-area-inset-bottom)) + 64px)',
              background: demoNote ? M.ai : c.collab.toast?.type === 'success' ? '#16a34a' : c.collab.toast?.type === 'error' ? '#dc2626' : M.blue,
            }}
            role="status"
          >
            {demoNote ?? c.collab.toast?.message}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
