/**
 * pageNav — the paginated-mode page-turn controls (ButtonRegistry component,
 * reader page only). Owns:
 *  - the #pageNavPrev / #pageNavNext buttons (markup in reader.blade.php,
 *    [hidden] until the paginator engages),
 *  - the document keydown page-turn keys (ArrowLeft/ArrowRight, PageUp/
 *    PageDown, Space / Shift+Space),
 *  - engagement wiring: re-runs the paginator's syncEngagement() after the
 *    first chunk lands (fresh load AND SPA nav) and on readingmodechange.
 *
 * Document-delegated singleton: create-once init (the contentHopper pattern);
 * re-init after SPA nav re-syncs engagement instead of re-binding.
 */

import { verbose } from '../../utilities/logger';
import { isAnyModalOpen } from '../../utilities/modalState';
import {
  isPaginatorEngaged,
  nextPage,
  prevPage,
  syncEngagement,
  disengageSilently,
} from '../../scrolling/paginator';
import { pendingFirstChunkLoadedPromise } from '../../pageLoad/firstChunkPromise';
import { getSavedAnchor, getFreshAnchor } from '../../scrolling/readingAnchor';
import { currentLazyLoader } from '../../pageLoad/currentLazyLoaderState';

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let clickHandler: ((e: MouseEvent) => void) | null = null;
let wheelHandler: ((e: WheelEvent) => void) | null = null;
let stateHandler: (() => void) | null = null;
let modeHandler: (() => void) | null = null;
let scrollHandler: (() => void) | null = null;
let scrollThrottle = 0;
let attached = false;

// Wheel-to-page-turn state: ONE page per continuous gesture. A trackpad
// two-finger swipe streams events for its whole momentum tail (often >1s), and
// the OS-generated tail decays to a dribble of tiny deltas. Two failure modes
// bound the design:
//   - a fixed lockout let the tail's leftovers re-accumulate into a 2nd page;
//   - keeping the gesture "alive" on EVERY event (incl. the tail dribble) meant
//     a 2nd swipe made before the tail fully died was swallowed forever — the
//     "turns one page then stops dead" bug.
// Fix: only SIGNIFICANT wheel motion (|delta| >= WHEEL_MOMENTUM_FLOOR) keeps a
// gesture alive. After a turn we stay DISARMED and re-arm only once there's been
// a real quiet stretch (WHEEL_GESTURE_GAP_MS) with no significant motion — which
// the decayed momentum tail can't prevent, but which a mid-swipe finger
// slow-down (brief, sub-gap) also can't fake into a second turn. A deliberate
// second swipe clears the gap and turns the next page; discrete mouse-wheel
// notches are naturally further apart than the gap, so each notch turns one.
const WHEEL_TURN_THRESHOLD = 50;
const WHEEL_GESTURE_GAP_MS = 180;
const WHEEL_MOMENTUM_FLOOR = 16; // |delta| below this = tail dregs, doesn't keep a gesture alive
let wheelAccum = 0;
let wheelArmed = true;
let lastActiveWheelAt = 0; // last SIGNIFICANT wheel motion (tail dribble excluded)

// Overlays/panels that scroll themselves (or own their wheel) — a wheel there
// must never turn the reader's page underneath.
const WHEEL_EXEMPT_SEL =
  '#hyperlit-container, #toc-container, #user-container, #source-container, '
  + '#newbook-container, #settings-container, #search-results-container, '
  + '#citation-toolbar-results, .shelf-preview-overlay, #search-toolbar, #edit-toolbar';

function isTypingContext(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/** Page-turn arrows exist only in paginated mode. */
function updateArrowVisibility(): void {
  const engaged = isPaginatorEngaged();
  const prev = document.getElementById('pageNavPrev');
  const next = document.getElementById('pageNavNext');
  if (prev) prev.hidden = !engaged;
  if (next) next.hidden = !engaged;
}

/**
 * Reading-progress % — shown in BOTH scroll and paginated modes. `[hidden]`
 * means "no data / not reading"; the perimeter-hidden CLASS (toggled by the
 * perimeter buttons) fades it when the user taps chrome away — the two compose.
 */
function updatePercent(percent: number | null): void {
  const pct = document.getElementById('pageNavPercent');
  if (!pct) return;
  const onReader = document.body.getAttribute('data-page') === 'reader';
  const editing = (window as unknown as { isEditing?: boolean }).isEditing === true;
  const show = onReader && !editing && typeof percent === 'number';
  pct.hidden = !show;
  if (show) pct.textContent = `${percent}%`;
}

/**
 * Scroll-mode progress: the saved reading anchor's node index over the total
 * node count — the same measure the paginator's percentThroughBook uses. Reads
 * getSavedAnchor (the throttled position saver's output), so it adds NO second
 * position detector (the one-detector gate) and is cheap on the scroll path.
 */
function computeScrollPercent(): number | null {
  const loader = currentLazyLoader as
    | { bookId?: string; nodes?: Array<{ startLine?: string | number }> }
    | null;
  if (!loader?.nodes?.length || !loader.bookId) return null;
  // Saved anchor on the hot scroll path (the throttled saver keeps it current);
  // fall back to a FRESH read only when nothing's been saved yet (at the top of
  // the book before the first scroll) so the initial % isn't blank.
  const anchor = getSavedAnchor(loader.bookId) ?? getFreshAnchor(loader.bookId);
  if (!anchor?.elementId) return null;
  const idx = loader.nodes.findIndex((n) => String(n.startLine) === anchor.elementId);
  if (idx < 0) return null;
  return Math.min(100, Math.round(((idx + 1) / loader.nodes.length) * 100));
}

/** In scroll mode, refresh the percent from the current reading position. */
function refreshScrollPercent(): void {
  if (isPaginatorEngaged()) return; // paginated mode drives % via paginatorstate
  updatePercent(computeScrollPercent());
}

export function initPageNav(): void {
  if (!attached) {
    keydownHandler = (e: KeyboardEvent) => {
      if (!isPaginatorEngaged()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isAnyModalOpen()) return;
      if ((window as unknown as { isEditing?: boolean }).isEditing) return;
      if (isTypingContext(e)) return;

      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          void nextPage();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          void prevPage();
          break;
        case ' ':
          e.preventDefault();
          void (e.shiftKey ? prevPage() : nextPage());
          break;
      }
    };
    document.addEventListener('keydown', keydownHandler);

    // Buttons are re-rendered markup after SPA nav — delegate from document.
    clickHandler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#pageNavNext')) {
        e.preventDefault();
        void nextPage();
      } else if (target.closest('#pageNavPrev')) {
        e.preventDefault();
        void prevPage();
      }
    };
    document.addEventListener('click', clickHandler);

    // Wheel / two-finger trackpad scroll turns pages (desktop e-reader
    // behavior). Non-capture so the wheelScrollForwarder's overlay exemptions
    // and scroll-mode forwarding (both capture-phase) stay untouched.
    wheelHandler = (e: WheelEvent) => {
      if (!isPaginatorEngaged()) return;
      if (isAnyModalOpen()) return;
      if ((window as unknown as { isEditing?: boolean }).isEditing) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && target.closest(WHEEL_EXEMPT_SEL)) return;

      // The wrapper can't scroll, so always claim the event while engaged
      // (stops root-scroller rubber-banding).
      e.preventDefault();

      const now = performance.now();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line-mode → ~px
      const absDelta = Math.abs(delta);
      // A quiet stretch with no SIGNIFICANT motion → the previous gesture (and
      // its momentum tail) is over; the next real push is a new gesture. Tail
      // dregs (|delta| < floor) don't count as motion, so they can't keep the
      // old gesture alive and lock out the next swipe.
      if (now - lastActiveWheelAt > WHEEL_GESTURE_GAP_MS) {
        wheelArmed = true;
        wheelAccum = 0;
      }
      if (absDelta >= WHEEL_MOMENTUM_FLOOR) lastActiveWheelAt = now;
      if (!wheelArmed) return; // momentum tail of a gesture that already turned

      wheelAccum += delta;
      if (Math.abs(wheelAccum) < WHEEL_TURN_THRESHOLD) return;

      const forward = wheelAccum > 0;
      wheelAccum = 0;
      wheelArmed = false; // one page per gesture — re-armed by a gap in significant motion
      void (forward ? nextPage() : prevPage());
    };
    document.addEventListener('wheel', wheelHandler, { passive: false });

    stateHandler = ((e: Event) => {
      const detail = (e as CustomEvent<{ percent?: number | null }>).detail;
      updateArrowVisibility();
      updatePercent(detail?.percent ?? null);
    }) as () => void;
    window.addEventListener('paginatorstate', stateHandler);

    modeHandler = () => {
      syncEngagement();
      refreshScrollPercent(); // scroll mode: paginatorstate won't fire
    };
    window.addEventListener('readingmodechange', modeHandler);

    // Scroll-mode progress: recompute on scroll (throttled). Capture phase —
    // scroll events don't bubble, and the reader wrapper is the scroller.
    scrollHandler = () => {
      if (isPaginatorEngaged() || scrollThrottle) return;
      scrollThrottle = window.setTimeout(() => {
        scrollThrottle = 0;
        refreshScrollPercent();
      }, 300);
    };
    document.addEventListener('scroll', scrollHandler, { capture: true, passive: true });

    attached = true;
    verbose.init('pageNav attached', '/components/pageNav/pageNav.ts');
  }

  // Every reader entry (full load or SPA nav): engage once the first chunk is
  // in the DOM — the paginator needs real geometry to measure. deferToRestore:
  // restoreScrollPosition owns BOOT positioning (hash deep links, saved
  // position) — the paginator engages the layout but must not place or save
  // a position of its own here.
  updateArrowVisibility();
  pendingFirstChunkLoadedPromise?.then(() => {
    syncEngagement({ deferToRestore: true });
    refreshScrollPercent(); // seed the scroll-mode % once content is in the DOM
  }).catch(() => {});
}

export function destroyPageNav(): void {
  // The reader DOM is being torn down — drop engine state without touching it.
  disengageSilently();
  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  if (clickHandler) document.removeEventListener('click', clickHandler);
  if (wheelHandler) document.removeEventListener('wheel', wheelHandler);
  if (stateHandler) window.removeEventListener('paginatorstate', stateHandler);
  if (modeHandler) window.removeEventListener('readingmodechange', modeHandler);
  if (scrollHandler) document.removeEventListener('scroll', scrollHandler, { capture: true } as any);
  if (scrollThrottle) { clearTimeout(scrollThrottle); scrollThrottle = 0; }
  keydownHandler = null;
  clickHandler = null;
  wheelHandler = null;
  stateHandler = null;
  modeHandler = null;
  scrollHandler = null;
  attached = false;
  verbose.init('pageNav destroyed', '/components/pageNav/pageNav.ts');
}
