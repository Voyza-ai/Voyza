'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { create } from 'zustand';

// ─── "Leave without saving?" ─────────────────────────────────────────────────
//
// A trip that was never saved lives only in this tab, and a two-finger swipe
// on a Mac trackpad is the browser's Back. The planner hands its trip to a
// bare /results, so Back went to /plan, whose mount wipes the store (and the
// tab's session snapshot with it): the trip was gone.
//
// Next.js moves between pages without unloading, so `beforeunload` never sees
// that Back. While a page has work that leaving would lose:
//
//  - Back / Forward (a swipe, the button, a key): the popstate is caught
//    before the app router renders the other page, the history is put back
//    where it was, and the dialog asks. Leave redoes the same move; Stay is
//    already home. No extra history entry is pushed — a pushed "guard" entry
//    is skipped by Chrome's Back when the page had no click since it was
//    added, and leaves a dead Back step behind once the work is saved.
//  - A link that leaves the page (the logo, the account menu): the click is
//    caught before the link's own handler, and Leave follows it.
//  - Closing the tab, reloading, typing an address: the browser's own dialog
//    (`beforeunload`; its text can't be changed).
//
// Navigations the app makes on purpose (the planner handing over to
// /results, a replan, Google's sign-in redirect) are not stopped: they are
// `router.push` calls, not popstates or link clicks, and the sign-in redirect
// says so first (allowUnload).

export type LeaveGuardCopy = { title: string; body: string };

export type LeavePrompt = {
  copy: LeaveGuardCopy;
  /** Stay on the page: the Stay button, Escape, a click outside. */
  stay: () => void;
  /** Go where the person was going. */
  leave: () => void;
};

type LeaveGuardState = {
  /** The dialog on screen, if any (rendered by LeaveGuardModal). */
  prompt: LeavePrompt | null;
  /** The page's own save, offered as "Save trip" (see useLeaveGuardSave). */
  save: (() => void) | null;
};

export const useLeaveGuardStore = create<LeaveGuardState>(() => ({ prompt: null, save: null }));

/** The copy of the page that asks before an in-app leave, while it does. */
let inAppCopy: (() => LeaveGuardCopy) | null = null;
/**
 * Leave was chosen for a link or a button: until the address changes, the
 * navigation it starts (and a full unload, e.g. Sign out) goes through.
 */
let leavingFrom: string | null = null;
const leaving = () => leavingFrom !== null && leavingFrom === window.location.href;
/** Leave was chosen for a Back/Forward: the popstate that redoes it goes through. */
let passPop = false;
/**
 * Until when a full-page navigation the app started on purpose (Google
 * sign-in) may unload the page unasked. Back on the page (Back from Google,
 * restored from the back/forward cache) it asks again.
 */
let unloadAllowedUntil = 0;
const UNLOAD_ALLOWED_MS = 30_000;
const unloadAllowed = () => Date.now() < unloadAllowedUntil;
/**
 * The page guard's Back/Forward handler, while a page asks before an in-app
 * leave. Reached through ONE listener added when this module loads (the root
 * layout imports it), which is before the app router hydrates and adds its
 * own: Chrome calls a window's popstate listeners in the order they were
 * added, capture or not, and the router's handler renders a cached page
 * synchronously — measured, it unmounted the planner, and the listener the
 * planner had added later was removed before it ever ran. `capture` puts it
 * first in browsers that run capture listeners first at the target.
 */
let popHandler: ((e: PopStateEvent) => void) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => popHandler?.(e), true);
  window.addEventListener('pageshow', () => {
    unloadAllowedUntil = 0;
  });
}
/** When a reload key was last pressed (see `reloadRestores`). */
let reloadKeyAt = Number.NEGATIVE_INFINITY;
const RELOAD_KEY_WINDOW_MS = 1500;
/** Most entries walked back over when the browser has no Navigation API. */
const MAX_WALK = 20;

function ask(copy: LeaveGuardCopy, go: () => void, closed?: () => void): LeavePrompt {
  const close = () => {
    if (useLeaveGuardStore.getState().prompt !== prompt) return false;
    useLeaveGuardStore.setState({ prompt: null });
    closed?.();
    return true;
  };
  const prompt: LeavePrompt = {
    copy,
    stay: () => {
      close();
    },
    leave: () => {
      if (close()) go();
    },
  };
  useLeaveGuardStore.setState({ prompt });
  return prompt;
}

/**
 * Run a navigation that leaves the page — asking first when the page has
 * unsaved work. For the app's own buttons that leave (a notification that
 * opens another trip, Sign out); links are caught without this.
 */
export function confirmLeave(go: () => void): void {
  if (!inAppCopy || leaving()) {
    go();
    return;
  }
  ask(inAppCopy(), () => {
    leavingFrom = window.location.href;
    go();
  });
}

/**
 * A full-page navigation the app starts on purpose (the Google sign-in
 * redirect): the browser's "Leave site?" dialog must not stop it. Returns an
 * undo, for when the navigation doesn't happen after all.
 */
export function allowUnload(): () => void {
  unloadAllowedUntil = Date.now() + UNLOAD_ALLOWED_MS;
  return () => {
    unloadAllowedUntil = 0;
  };
}

/**
 * The page's own save, offered in the dialog as "Save trip" while `save` is
 * given. The dialog closes (the person stays) and the save runs.
 */
export function useLeaveGuardSave(save: (() => void) | null): void {
  const ref = useRef(save);
  ref.current = save;
  const has = !!save;
  useEffect(() => {
    if (!has) return;
    const run = () => ref.current?.();
    useLeaveGuardStore.setState({ save: run });
    return () => {
      if (useLeaveGuardStore.getState().save === run) useLeaveGuardStore.setState({ save: null });
    };
  }, [has]);
}

/** This tab's place in its history, where the browser says (Navigation API). */
function entryIndex(): number | null {
  const nav = (window as any).navigation;
  const i = nav?.currentEntry?.index;
  return typeof i === 'number' && i >= 0 ? i : null;
}

type Home = { href: string; index: number | null };
const here = (): Home => ({ href: window.location.href, index: entryIndex() });

export type LeaveGuardOptions = {
  /** Leaving in the app (Back/Forward, a swipe, a link) would lose work: ask. */
  inApp: boolean;
  /** Closing, reloading or leaving the site would lose work: the browser asks. */
  unload: boolean;
  /**
   * A reload brings the work back (an unsaved trip's session snapshot), so a
   * reload from the keyboard (⌘R, Ctrl+R, F5) isn't asked about. The
   * browser's dialog can't tell a reload from a close, so the toolbar's
   * reload button still asks: closing the tab would lose the work.
   */
  reloadRestores?: boolean;
  copy: LeaveGuardCopy;
};

/**
 * Ask before this page is left while it has unsaved work. See the top of
 * this file for what is caught and how.
 */
export function useLeaveGuard({ inApp, unload, reloadRestores = false, copy }: LeaveGuardOptions): void {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const copyRef = useRef(copy);
  copyRef.current = copy;

  // Closing the tab, reloading, typing an address: the browser's dialog.
  useEffect(() => {
    if (!unload) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key?.toLowerCase();
      if (k === 'f5' || ((e.metaKey || e.ctrlKey) && k === 'r')) reloadKeyAt = Date.now();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving() || unloadAllowed()) return;
      const reloadKey = Date.now() - reloadKeyAt < RELOAD_KEY_WINDOW_MS;
      reloadKeyAt = Number.NEGATIVE_INFINITY;
      if (reloadRestores && reloadKey) return;
      e.preventDefault();
      // Chrome before 119 and older Safari show the dialog only for this.
      e.returnValue = true;
    };
    reloadKeyAt = Number.NEGATIVE_INFINITY;
    if (reloadRestores) window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [unload, reloadRestores]);

  // Where "here" is in the history. It follows the page while nothing is
  // being asked (a save gives the trip its address in place), and holds still
  // while a Back is being undone.
  const homeRef = useRef<Home | null>(null);
  const holdRef = useRef(false);
  useEffect(() => {
    if (inApp && !holdRef.current) homeRef.current = here();
  });

  useEffect(() => {
    if (!inApp) return;
    const copyNow = () => copyRef.current;
    inAppCopy = copyNow;
    leavingFrom = null;
    passPop = false;
    homeRef.current = here();
    let mine: LeavePrompt | null = null;

    // ── Back / Forward ──
    // `restoring`: on the way back home after a caught move. `away`: the
    // move that was caught, as history.go(away) redoes it.
    let restoring: { steps: number } | null = null;
    let away = 0;
    let leaveOnceHome = false;
    const settle = () => {
      holdRef.current = !!restoring || (!!mine && useLeaveGuardStore.getState().prompt === mine);
    };
    const goAway = () => {
      if (away === 0) return;
      passPop = true;
      window.history.go(away);
    };
    const onPopState = (e: PopStateEvent) => {
      if (passPop && !restoring) {
        passPop = false;
        return;
      }
      const home = homeRef.current;
      if (!home) return;
      const index = entryIndex();
      const atHome = index != null && home.index != null ? index === home.index : window.location.href === home.href;
      if (restoring) {
        e.stopImmediatePropagation();
        if (atHome) {
          restoring = null;
          if (leaveOnceHome) goAway();
        } else if (index == null && restoring.steps < MAX_WALK) {
          restoring.steps += 1;
          away -= 1;
          window.history.forward();
        } else {
          restoring = null;
        }
        settle();
        return;
      }
      if (atHome) return; // not a move off this page
      // The router must not render the other page: this one stays, and the
      // history goes back to it.
      e.stopImmediatePropagation();
      leaveOnceHome = false;
      if (index != null && home.index != null) {
        away = index - home.index;
        restoring = { steps: 0 };
        window.history.go(-away);
      } else {
        // No Navigation API: the move was most likely one step back; walk
        // forward until home (see the restoring branch above).
        away = -1;
        restoring = { steps: 1 };
        window.history.forward();
      }
      mine = ask(
        copyRef.current,
        () => {
          if (restoring) leaveOnceHome = true;
          else goAway();
        },
        settle,
      );
      settle();
    };

    // ── Links that leave the page ──
    const onClick = (e: MouseEvent) => {
      if (leaving() || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab or window: nothing is lost
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return; // leaves the site: the browser asks
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      // Before the link's own handler (the app router's), which never runs.
      e.preventDefault();
      e.stopPropagation();
      const href = url.pathname + url.search + url.hash;
      mine = ask(copyRef.current, () => {
        leavingFrom = window.location.href;
        routerRef.current.push(href);
      });
    };

    // Chrome and Edge on macOS turn a two-finger swipe that overscrolls the
    // page sideways into Back; this stops it at the source (Safari ignores it,
    // and the popstate catch above still asks there).
    const root = document.documentElement;
    const body = document.body;
    const before = [root.style.overscrollBehaviorX, body.style.overscrollBehaviorX];
    root.style.overscrollBehaviorX = 'none';
    body.style.overscrollBehaviorX = 'none';

    // Back/Forward: ahead of the app router (see popHandler). Links: window
    // capture, ahead of every click handler on the page.
    popHandler = onPopState;
    window.addEventListener('click', onClick, true);
    return () => {
      if (popHandler === onPopState) popHandler = null;
      window.removeEventListener('click', onClick, true);
      root.style.overscrollBehaviorX = before[0];
      body.style.overscrollBehaviorX = before[1];
      if (inAppCopy === copyNow) inAppCopy = null;
      holdRef.current = false;
      // The work was saved, or the page is gone: nothing left to ask about.
      if (mine && useLeaveGuardStore.getState().prompt === mine) useLeaveGuardStore.setState({ prompt: null });
    };
  }, [inApp]);
}
