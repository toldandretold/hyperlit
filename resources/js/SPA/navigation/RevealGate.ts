/**
 * RevealGate — holds the boot overlay up as a "Finding your previous
 * position…" curtain until the scroll restore has verifiably SETTLED, so the
 * reader never watches the landing corrections yank the page around.
 *
 * Lifecycle (all static, one gate at a time — mirrors NavigationCompletionBarrier):
 *   arm(bookId)      — viewManager (early) / restore.ts (late), idempotent.
 *                      Refuses to hold unless the overlay is currently visible
 *                      (never re-curtains an already-revealed page).
 *   landed(scroller, navPromise)
 *                    — restore.ts, with navigateToInternalId's promise. When
 *                      it resolves ("landed, not stable" — internalNav's 0/500ms
 *                      cleanup), a rAF stability watch runs: 400ms continuous of
 *                      belt-quiet + unmoved scrollTop → reveal.
 *   completion()     — NavigationManager awaits this BEFORE hiding the overlay.
 *   disarm()         — every restore bail path / load failure: release with no hold.
 *
 * Escapes (the gate never fights the reader):
 *   - 4s hard cap → reveal regardless (the belts keep settling behind the page).
 *   - any real gesture (wheel / touchmove / scroll keys) → reveal immediately.
 *   - Escape → reveal in place, keeping the restored position.
 *   - "Go to top of book" button → cancel all pending corrections permanently
 *     (synthetic gesture stamp + barrier abort), scroll to 0, save, reveal.
 */

import { log } from '../../utilities/logger';
import { setSkipScrollRestoration } from '../../utilities/operationState';
import { userScrollState } from '../../scrolling/navState';
import { stampSyntheticGesture } from '../../scrolling/userScrollDetection';
import { nextScrollReason } from '../../scrolling/scrollTrace';
import { isBeltQuiet } from '../../lazyLoader/imageState';
import { NavigationCompletionBarrier } from './NavigationCompletionBarrier';
import { ProgressOverlayEnactor } from './ProgressOverlayEnactor';

const HARD_CAP_MS = 4000;
const STABLE_WINDOW_MS = 400;
const GESTURE_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

type ScrollerLike = Element & {
  scrollTop: number;
  scrollTo(options?: ScrollToOptions): void;
};

export class RevealGate {
  static state: 'idle' | 'holding' = 'idle';
  static bookId: string | null = null;

  // ONE hold per page entry. Once the gate has revealed (gesture, stability,
  // cap, go-to-top, disarm), a LATER arm() in the same entry must not
  // re-curtain — restore.ts's late-arm runs when the first chunk lands, which
  // on a slow boot is AFTER the reader already wheeled the curtain away
  // (mobile: wheel → reveal → restore late-arms → curtain back up = the gate
  // fighting the reader). viewManager resets this at each reader entry.
  private static spent = false;

  private static holdPromise: Promise<void> | null = null;
  private static holdResolve: (() => void) | null = null;
  private static capTimer: ReturnType<typeof setTimeout> | null = null;
  private static rafId: number | null = null;
  private static armGestureStamp = 0;
  private static armedAtMs = 0;
  private static removeListeners: (() => void) | null = null;
  private static landedRegistered = false;

  /** New page entry: allow the (single) hold again. Called by viewManager. */
  static newBoot(): void {
    this.spent = false;
  }

  /** Begin holding the reveal. Idempotent; no-op unless the overlay is up. */
  static arm(bookId: string): void {
    if (this.state === 'holding') return;
    if (this.spent) return; // already revealed this entry — never re-curtain
    // Late-arm guard: if the boot overlay is already gone (bfcache force-hide,
    // NavigationManager already revealed), a curtain now would flash over a
    // page the reader can see — refuse. init() first: the Enactor binds
    // lazily, and until it has bound its state says 'hidden' even while the
    // blade's server-rendered overlay is plainly visible.
    ProgressOverlayEnactor.init();
    if (!ProgressOverlayEnactor.isVisible()) return;

    this.state = 'holding';
    this.bookId = bookId;
    this.landedRegistered = false;
    this.armedAtMs = Date.now();
    this.armGestureStamp = userScrollState.lastGestureScrollTime;
    this.holdPromise = new Promise<void>((resolve) => {
      this.holdResolve = resolve;
    });

    this.capTimer = setTimeout(() => this.revealNow('timeout'), HARD_CAP_MS);
    this._attachGestureListeners();
    void ProgressOverlayEnactor.showResumeCurtain().then((shown) => {
      // A hide raced us — the page is (about to be) visible; holding a reveal
      // nobody can see would just stall NavigationManager. Release.
      if (!shown) this.revealNow('overlay-gone');
    });
  }

  /**
   * The restore's navigation promise is in flight. When it lands, watch for
   * stability (belt quiet + scrollTop unmoved for a continuous window), then
   * reveal.
   */
  static landed(scroller: Element | null | undefined, navPromise: Promise<unknown>): void {
    if (this.state !== 'holding' || !scroller) return;
    this.landedRegistered = true;
    Promise.resolve(navPromise)
      .catch(() => null)
      .then(() => this._watchStability(scroller as ScrollerLike));
  }

  /** Resolved promise when idle; the hold promise while a curtain is up. */
  static completion(): Promise<void> {
    return this.state === 'holding' && this.holdPromise ? this.holdPromise : Promise.resolve();
  }

  /** Release with no reveal semantics (restore bailed / load failed). */
  static disarm(): void {
    this.revealNow('disarmed');
  }

  /**
   * restoreScrollPosition finished without handing us a navigation to watch
   * (a bail path, the chunk-0 top-of-book path, or a throw). A hold nobody
   * will ever resolve must release — otherwise the 4s cap becomes the UX.
   */
  static releaseIfUnclaimed(): void {
    if (this.state === 'holding' && !this.landedRegistered) {
      this.revealNow('restore-did-not-navigate');
    }
  }

  /** Release the hold and return the overlay to plain progress mode. */
  static revealNow(reason: string): void {
    if (this.state !== 'holding') return;
    this.state = 'idle';
    this.spent = true; // one hold per page entry — see newBoot()
    if (this.capTimer) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.removeListeners?.();
    this.removeListeners = null;
    ProgressOverlayEnactor.endResumeCurtain();
    log.nav(`RevealGate: revealed (${reason}) after ${Date.now() - this.armedAtMs}ms`, 'navigation/RevealGate');
    this.holdResolve?.();
    this.holdResolve = null;
    this.holdPromise = null;
    this.bookId = null;
  }

  /**
   * The curtain's escape hatch: abandon the restore, land at the top of the
   * book, and make sure no late correction re-asserts the abandoned target.
   *
   * "Top" is a real NAVIGATION to the book's first node, never a bare
   * scrollTo(0): in the windowed DOM, scrollTop 0 is the top of the RENDERED
   * window (mid-book after a deep restore) — the top sentinel then fires,
   * loadPreviousChunkFixed prepends + compensates scrollTop back down, and
   * the settle belt (neither isScrolling nor isNavigating set) reads that
   * prepend as drift and doubles it (forensics: 0 → 13733 → 27483).
   * navigateToInternalId loads chunk 0 properly and holds isNavigating, so
   * the belt stands down for the landing.
   */
  static goToTop(): void {
    // The curtain exists from FIRST PAINT (blade escalation), so this click
    // can land BEFORE restoreScrollPosition has even fired its navigation —
    // the gesture stamp below only cancels IN-FLIGHT machinery, and a
    // not-yet-started restore would run afterwards and yank the reader back
    // to the abandoned deep anchor. Restore's own one-shot yield seam covers
    // exactly this: set the global skip flag, restore bails at entry and
    // clears it. Only when the restore hasn't handed us its navigation yet —
    // if it already ran, the flag would go stale and silently eat the NEXT
    // legitimate restore instead.
    if (!this.landedRegistered) {
      setSkipScrollRestoration(true);
    }
    // Synthetic gesture: scrollHelpers' landing belt and the imageState
    // debt-drop both key off lastGestureScrollTime — this is the existing
    // cancel-all-corrections mechanism for the ABANDONED restore. The new
    // navigation below snapshots the gesture clock at its own entry, so the
    // stamp cannot cancel it.
    stampSyntheticGesture();
    NavigationCompletionBarrier.abort();
    userScrollState.isNavigating = false;

    void Promise.all([
      import('../../pageLoad/currentLazyLoaderState'),
      import('../../scrolling/internalNav'),
    ]).then(async ([loaderState, { navigateToInternalId }]) => {
      // The click can beat the node map: the curtain arms in viewManager
      // BEFORE loadHyperText has populated loader.nodes, and an empty map
      // would drop us into the bare-scroll fallback (the prepend-shove trap
      // this method exists to avoid). First chunk in DOM ⇒ map populated.
      try {
        const { pendingFirstChunkLoadedPromise } = await import('../../pageLoad/firstChunkPromise');
        await Promise.race([
          pendingFirstChunkLoadedPromise ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch { /* best-effort */ }

      const loader = loaderState.currentLazyLoader as {
        nodes?: Array<{ startLine: number | string }>;
        scrollableParent?: ScrollerLike;
        saveScrollPosition?: () => void;
      } | null;
      if (!loader) return;

      const first = (loader.nodes ?? []).reduce<{ startLine: number | string } | null>(
        (min, node) => (min === null || Number(node.startLine) < Number(min.startLine) ? node : min),
        null,
      );
      const finishWithSave = () => setTimeout(() => loader.saveScrollPosition?.(), 300);

      if (first != null) {
        Promise.resolve(navigateToInternalId(String(first.startLine), loader, false, 0))
          .catch(() => null)
          // Persist "top" as the new position so a reload doesn't re-restore
          // the abandoned deep anchor.
          .then(finishWithSave);
      } else if (loader.scrollableParent) {
        // No node map (empty/still-loading book): nothing exists above the
        // rendered window, so a plain scroll is safe here.
        nextScrollReason('resume-curtain-go-top');
        loader.scrollableParent.scrollTo({ top: 0, behavior: 'auto' });
        finishWithSave();
      }
    });

    this.revealNow('go-to-top');
  }

  private static _watchStability(scroller: ScrollerLike): void {
    if (this.state !== 'holding') return;
    let stableSince = performance.now();
    let lastTop = scroller.scrollTop;

    const tick = () => {
      if (this.state !== 'holding') return;
      // Belt-and-braces vs the listeners: any gesture after arm = user owns it.
      if (userScrollState.lastGestureScrollTime > this.armGestureStamp) {
        this.revealNow('gesture-during-hold');
        return;
      }
      const now = performance.now();
      const top = scroller.scrollTop;
      if (Math.abs(top - lastTop) > 1 || !isBeltQuiet(scroller)) {
        stableSince = now;
        lastTop = top;
      }
      if (now - stableSince >= STABLE_WINDOW_MS) {
        this.revealNow('stable');
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private static _attachGestureListeners(): void {
    const onGesture = () => this.revealNow('user-gesture');
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.revealNow('escape');
        return;
      }
      // Space on the focused go-to-top button is button activation, not a
      // scroll gesture — let the button's own click handler own it.
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('button')) return;
      if (GESTURE_KEYS.includes(event.key)) onGesture();
    };
    window.addEventListener('wheel', onGesture, { passive: true, capture: true });
    window.addEventListener('touchmove', onGesture, { passive: true, capture: true });
    window.addEventListener('keydown', onKeydown, { capture: true });
    this.removeListeners = () => {
      window.removeEventListener('wheel', onGesture, { capture: true });
      window.removeEventListener('touchmove', onGesture, { capture: true });
      window.removeEventListener('keydown', onKeydown, { capture: true });
    };
  }
}

// Debug hook, matching the other navigation singletons.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).RevealGate = RevealGate;
}
