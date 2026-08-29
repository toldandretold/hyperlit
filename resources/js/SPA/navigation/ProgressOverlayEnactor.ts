/**
 * ProgressOverlayEnactor - Enacts DOM manipulation for progress overlay system
 *
 * Handles the mechanics of showing/hiding the progress overlay (both the overlay div and progress bar).
 * This is the "hands" that actually manipulate the DOM - no business logic, just execution.
 *
 * KEY DESIGN PRINCIPLES:
 * 1. Single Promise Pattern - concurrent hide() calls return the same promise
 * 2. State Machine - clear states (hidden/visible/hiding) prevent confusion
 * 3. Finally Block - guarantees overlay hides even on errors
 * 4. Fast Animation - 200ms max, no user frustration
 * 5. Idempotent - calling methods multiple times is safe
 *
 * USAGE:
 * - ProgressOverlayEnactor.show(percent, message) - Show overlay with progress
 * - ProgressOverlayEnactor.update(percent, message) - Update progress
 * - ProgressOverlayEnactor.hide() - Hide overlay (async, guaranteed to complete)
 * - ProgressOverlayEnactor.forceHide() - Emergency hide (sync, no animation)
 */

import { log, verbose } from '../../utilities/logger';

export class ProgressOverlayEnactor {
  // DOM element references
  static overlay: any = null;
  static progressBar: any = null;
  static progressText: any = null;
  static progressDetails: any = null;

  // State machine
  static state = 'hidden'; // 'hidden' | 'visible' | 'hiding'

  // When the overlay became visible (ms epoch), null while hidden. Lets
  // healthCheck distinguish a legitimately in-flight transition overlay
  // from a STUCK one (visible far longer than any transition should take).
  static visibleSince: number | null = null;

  // Hide operation promise (for preventing concurrent hides)
  static hidePromise: any = null;

  // Track contenteditable state
  static wasContentEditable = false;

  // Resume-curtain mode (RevealGate): the overlay is escalated from a
  // translucent progress scrim to an opaque "Finding your previous position…"
  // hold with a go-to-top escape button. While true, update() must not
  // overwrite the curtain text with "Loading… N%".
  static resumeCurtain = false;
  static curtainButton: any = null;
  // A hide() refused while the curtain was holding. On a COLD boot the boot
  // flow's hide call can be the ONLY one (NavigationManager isn't driving), so
  // if the gate releases AFTER that call was refused, nobody would ever hide
  // the scrim — endResumeCurtain replays it.
  static hideDeferredByCurtain = false;

  /**
   * Initialize DOM element references
   * Called lazily on first use
   */
  static init() {
    if (this.overlay && this.overlay.isConnected) return; // Already initialized and still in DOM

    this._bindElements();
  }

  /**
   * Bind (or rebind) to DOM elements
   * Used both for initial setup and after body replacements during SPA navigation
   */
  static _bindElements() {
    this.overlay = document.getElementById('initial-navigation-overlay');
    this.progressBar = document.getElementById('page-load-progress-bar');
    this.progressText = document.getElementById('page-load-progress-text');
    this.progressDetails = document.getElementById('page-load-progress-details');

    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = 'initial-navigation-overlay';
      this.overlay.className = 'navigation-overlay';
      this.overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:10000;pointer-events:none;display:none;';

      const wrapper = document.createElement('div');
      wrapper.id = 'progress-overlay-wrapper';
      wrapper.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:transparent;padding:2em;width:400px;max-width:70vw;';

      this.progressText = document.createElement('p');
      this.progressText.className = 'progress-text';
      this.progressText.id = 'page-load-progress-text';
      this.progressText.style.cssText = 'color:#CBCCCC;text-align:center;margin:0 0 1em 0;font-size:16px;';
      this.progressText.textContent = 'Loading...';

      const barContainer = document.createElement('div');
      barContainer.className = 'progress-bar-container';
      barContainer.style.cssText = 'width:100%;height:20px;background:#ddd;border-radius:10px;overflow:hidden;margin:1em 0;';

      this.progressBar = document.createElement('div');
      this.progressBar.className = 'progress-bar';
      this.progressBar.id = 'page-load-progress-bar';
      this.progressBar.style.cssText = 'width:5%;height:100%;background:linear-gradient(to right,#EE4A95,#EF8D34,#4EACAE,#EE4A95);transition:width 0.3s;';

      this.progressDetails = document.createElement('p');
      this.progressDetails.className = 'progress-details';
      this.progressDetails.id = 'page-load-progress-details';
      this.progressDetails.style.cssText = 'color:#888;text-align:center;margin:0.5em 0 0 0;font-size:12px;';
      this.progressDetails.textContent = 'Initializing...';

      barContainer.appendChild(this.progressBar);
      wrapper.appendChild(this.progressText);
      wrapper.appendChild(barContainer);
      wrapper.appendChild(this.progressDetails);
      this.overlay.appendChild(wrapper);
      document.body.appendChild(this.overlay);
    }

    // 🔥 CRITICAL FIX: Use getComputedStyle to detect actual visibility
    // This handles both inline styles and CSS defaults correctly
    const computedDisplay = window.getComputedStyle(this.overlay).display;
    const isCurrentlyVisible = computedDisplay !== 'none';

    if (isCurrentlyVisible) {
      this.state = 'visible';
      if (this.visibleSince === null) this.visibleSince = Date.now();
      verbose.debug('ProgressOverlayEnactor: Bound to overlay (currently VISIBLE)', 'navigation/ProgressOverlayEnactor.js');
    } else {
      this.state = 'hidden';
      this.visibleSince = null;
      verbose.debug('ProgressOverlayEnactor: Bound to overlay (currently HIDDEN)', 'navigation/ProgressOverlayEnactor.js');
    }
  }

  /**
   * Rebind to DOM elements after body replacement
   * Call this after SPA navigation that swaps body content
   */
  static rebind() {
    verbose.debug('ProgressOverlayEnactor: Rebinding to DOM after body replacement', 'navigation/ProgressOverlayEnactor.js');
    this._bindElements();
  }

  /**
   * Show the overlay with initial progress
   * Idempotent - safe to call multiple times
   *
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} message - Progress message to display
   * @param {boolean} blockInteractions - If true, block all user interactions (default: false)
   */
  static show(percent = 5, message = 'Loading...', blockInteractions = false) {
    this.init();

    if (!this.overlay) {
      return;
    }

    // A stale blade-escalated curtain (bfcache force-hide skipped every JS
    // cleanup path) must never leak into a plain progress show — reset it.
    if (!this.resumeCurtain && this.overlay.dataset?.hlHold) {
      this.endResumeCurtain();
    }

    // Don't interrupt a hide operation
    if (this.state === 'hiding') {
      verbose.debug('ProgressOverlayEnactor.show: Hide in progress, skipping show', 'navigation/ProgressOverlayEnactor.js');
      return;
    }

    // Already visible? Just update progress
    if (this.state === 'visible') {
      verbose.debug('ProgressOverlayEnactor.show: Already visible, updating progress', 'navigation/ProgressOverlayEnactor.js');
      this.update(percent, message);
      return;
    }

    verbose.debug(`ProgressOverlayEnactor.show: Showing overlay (${percent}% - ${message}, block: ${blockInteractions})`, 'navigation/ProgressOverlayEnactor.js');

    this.state = 'visible';
    this.visibleSince = Date.now();
    this.overlay.style.display = 'block';
    this.overlay.style.visibility = 'visible';
    // Use setProperty with !important to override inline styles from blade template
    this.overlay.style.setProperty('pointer-events', blockInteractions ? 'auto' : 'none', 'important');

    // Block interactions by disabling contenteditable on main editor
    if (blockInteractions) {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        this.wasContentEditable = mainContent.getAttribute('contenteditable') === 'true';
        if (this.wasContentEditable) {
          mainContent.setAttribute('contenteditable', 'false');
          verbose.debug('ProgressOverlayEnactor: Disabled contenteditable on .main-content', 'navigation/ProgressOverlayEnactor.js');
        }
      }
    }

    this.update(percent, message);
  }

  /**
   * Update progress bar and message
   * Can be called any time, even if overlay is hidden
   */
  static update(percent: any, message: any = null) {
    this.init();

    if (this.progressBar) {
      // Ensure progress never goes below 5% (visual feedback)
      const adjustedPercent = Math.max(5, Math.min(100, percent));
      this.progressBar.style.width = adjustedPercent + '%';
    }

    // Curtain mode owns the text — progress callbacks keep feeding the (hidden)
    // bar but must not clobber "Finding your previous position…".
    if (this.resumeCurtain) return;

    if (this.progressText) {
      this.progressText.textContent = `Loading... ${Math.round(percent)}%`;
      this.progressText.style.opacity = '1'; // Reset opacity in case it was hidden
    }

    if (message && this.progressDetails) {
      this.progressDetails.textContent = message;
      this.progressDetails.style.opacity = '1'; // Reset opacity
    }
  }

  /**
   * Escalate the (already visible) boot overlay into the resume curtain:
   * opaque, interaction-blocking, spinner + "Restoring your reading
   * position…" with a quiet go-to-top text escape. Returns false when the
   * overlay is gone or a hide
   * is in flight — the caller (RevealGate) must then release its hold rather
   * than curtain a page the reader can already see.
   */
  static async showResumeCurtain(): Promise<boolean> {
    this.init();
    if (!this.overlay) return false;

    // A hide in flight means some path already decided to reveal — do not
    // re-show over it. Wait it out and report failure.
    if (this.hidePromise) {
      try { await this.hidePromise; } catch { /* hide always settles */ }
      return false;
    }
    if (this.state !== 'visible') return false;

    this.resumeCurtain = true;
    this.hideDeferredByCurtain = false; // fresh hold — no stale replay
    this.overlay.dataset.hlHold = '1'; // blade visibilitychange guard reads this
    // Opaque + interaction-blocking (the blade default is a 30% click-through
    // scrim — the whole point of the curtain is that unpositioned content is
    // neither visible nor interactive). !important mirrors show()'s override
    // of the blade inline style. The transition is added BEFORE the background
    // write: on a fresh boot the blade already painted it opaque (no change →
    // no animation), while on an SPA book-to-book entry this fades the scrim
    // to black; either way endResumeCurtain's change fades the reveal instead
    // of snapping.
    this.overlay.style.transition = 'background 250ms ease';
    this.overlay.style.setProperty('background', 'rgba(9, 10, 13, 0.98)');
    this.overlay.style.setProperty('pointer-events', 'auto', 'important');

    const barContainer = this.overlay.querySelector('.progress-bar-container');
    if (barContainer) barContainer.style.display = 'none'; // reads as "loading", wrong message
    this._ensureCurtainSpinner();
    if (this.progressText) {
      this.progressText.textContent = 'Restoring your reading position…';
      this.progressText.style.opacity = '1';
    }
    if (this.progressDetails) {
      this.progressDetails.textContent = '';
    }
    this._ensureCurtainButton();
    verbose.debug('ProgressOverlayEnactor: resume curtain shown', 'navigation/ProgressOverlayEnactor.js');
    return true;
  }

  /**
   * Drop curtain mode WITHOUT hiding the overlay — it returns to the plain
   * translucent progress scrim (the load may still be running; hide() is
   * NavigationManager's call). Idempotent.
   */
  static endResumeCurtain() {
    // The blade escalates the curtain at FIRST PAINT (data-hl-hold + opaque
    // background) before RevealGate ever arms — if the gate then never holds
    // (restore bails, load fails), the flag is false but the visuals must
    // still be reset, or a later show() would present an opaque hlHold scrim.
    const bladeEscalated = !!this.overlay?.dataset?.hlHold;
    if (!this.resumeCurtain && !bladeEscalated) return;
    this.resumeCurtain = false;
    if (!this.overlay) return;
    delete this.overlay.dataset.hlHold;
    this.overlay.style.setProperty('background', 'rgba(0, 0, 0, 0.3)');
    this.overlay.style.setProperty('pointer-events', 'none', 'important');
    const barContainer = this.overlay.querySelector('.progress-bar-container');
    if (barContainer) barContainer.style.display = '';
    if (this.curtainButton) this.curtainButton.style.display = 'none';
    if (this.curtainSpinner) this.curtainSpinner.style.display = 'none';
    verbose.debug('ProgressOverlayEnactor: resume curtain ended', 'navigation/ProgressOverlayEnactor.js');
    // Replay a hide the curtain refused (cold-boot case: that refused call was
    // the only one coming). Safe re-entrancy: resumeCurtain is false now, so
    // hide() proceeds; its finally calls endResumeCurtain again, which
    // early-returns (no curtain, no hlHold).
    if (this.hideDeferredByCurtain) {
      this.hideDeferredByCurtain = false;
      void this.hide();
    }
  }

  /**
   * Create-once the curtain's spinner (replaces the progress bar for this
   * mode — "hold on a moment", not "loading N%").
   */
  static curtainSpinner: any = null;

  static _ensureCurtainSpinner() {
    const wrapper = this.overlay?.querySelector('#progress-overlay-wrapper');
    if (!wrapper) return;
    if (!document.getElementById('resume-curtain-style')) {
      const style = document.createElement('style');
      style.id = 'resume-curtain-style';
      style.textContent = '@keyframes hl-curtain-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
    if (!this.curtainSpinner || !this.curtainSpinner.isConnected) {
      const spinner = document.createElement('div');
      spinner.id = 'resume-curtain-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      spinner.style.cssText = 'width:26px;height:26px;margin:0 auto 1.2em;border:2px solid rgba(203,204,204,0.2);border-top-color:#CBCCCC;border-radius:50%;animation:hl-curtain-spin 0.8s linear infinite;';
      wrapper.insertBefore(spinner, wrapper.firstChild);
      this.curtainSpinner = spinner;
    }
    this.curtainSpinner.style.display = 'block';
  }

  /**
   * Create-once the curtain's escape, styled as a quiet underlined text line
   * (NOT a boxed button): resuming the saved position is the preferred path,
   * so this must read as an aside, not a call to action. Focus still seats on
   * it so keyboard users can Enter (go to top) or Escape (reveal in place)
   * without hunting.
   */
  static _ensureCurtainButton() {
    const wrapper = this.overlay?.querySelector('#progress-overlay-wrapper');
    if (!wrapper) return;
    if (!this.curtainButton || !this.curtainButton.isConnected) {
      const btn = document.createElement('button');
      btn.id = 'resume-curtain-top-btn';
      btn.type = 'button';
      btn.textContent = 'go to top of book instead';
      btn.style.cssText = 'display:block;margin:1.4em auto 0;padding:0;font-size:13px;color:#9aa0a6;background:none;border:none;text-decoration:underline;text-underline-offset:2px;cursor:pointer;';
      // Dynamic import: RevealGate statically imports this module — a static
      // back-import would create a cycle (circular-import TDZ class of bug).
      btn.addEventListener('click', () => {
        void import('./RevealGate').then(({ RevealGate }) => RevealGate.goToTop());
      });
      wrapper.appendChild(btn);
      this.curtainButton = btn;
    }
    this.curtainButton.style.display = 'block';
    this.curtainButton.focus({ preventScroll: true });
  }

  /**
   * Hide the overlay with smooth animation
   *
   * KEY FEATURES:
   * - Returns same promise if already hiding (prevents race conditions)
   * - Always completes via finally block (guaranteed hide)
   * - Fast 200ms animation (no user frustration)
   *
   * @returns {Promise<void>} Resolves when hide is complete
   */
  static async hide() {
    this.init();

    if (!this.overlay) {
      return Promise.resolve();
    }

    // Resume-curtain hold: ad-hoc hide callers (internalNav's landing cleanup,
    // domReadiness fallbacks) fire at "landed", which is exactly when the
    // curtain must still be up — the settle window is the point. Refuse; the
    // legitimate hide arrives via NavigationManager AFTER RevealGate resolves
    // (which ends curtain mode first, so this guard can't wedge: the gate is
    // hard-capped at 4s and forceHide() bypasses everything).
    if (this.resumeCurtain) {
      // Remember the refusal: on a cold boot this may be the boot flow's ONLY
      // hide call, and the reveal (gesture / stability / cap) can come after
      // it — endResumeCurtain replays the hide so the scrim can't stay up.
      this.hideDeferredByCurtain = true;
      verbose.debug('ProgressOverlayEnactor.hide: deferred — resume curtain holding', 'navigation/ProgressOverlayEnactor.js');
      return Promise.resolve();
    }

    // Already hidden? Nothing to do
    if (this.state === 'hidden') {
      verbose.content('ProgressOverlayEnactor.hide: Already hidden, skipping', 'navigation/ProgressOverlayEnactor.js');
      return Promise.resolve();
    }

    // Already hiding? Return the existing promise
    if (this.hidePromise) {
      verbose.content('ProgressOverlayEnactor.hide: Hide already in progress, returning existing promise', 'navigation/ProgressOverlayEnactor.js');
      return this.hidePromise;
    }

    verbose.content('ProgressOverlayEnactor.hide: Starting hide sequence', 'navigation/ProgressOverlayEnactor.js');

    // Create and store the hide operation promise
    this.hidePromise = this._performHide();

    try {
      await this.hidePromise;
    } finally {
      // Clear the promise reference when done
      this.hidePromise = null;
    }
  }

  /**
   * Internal method that performs the actual hide operation
   * ALWAYS completes via finally block
   */
  static async _performHide() {
    this.state = 'hiding';

    try {
      // Fade out text elements first for clean visual
      if (this.progressText) {
        this.progressText.style.opacity = '0';
      }
      if (this.progressDetails) {
        this.progressDetails.style.opacity = '0';
      }

      // Quick animation to 100% for visual satisfaction
      if (this.progressBar) {
        const currentWidth = parseInt(this.progressBar.style.width) || 5;

        // If we're not near 100%, animate there
        if (currentWidth < 90) {
          this.progressBar.style.width = '100%';
          // Wait for CSS transition (200ms max)
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

    } catch (error) {
      // Log error but don't let it prevent hiding
      log.error('ProgressOverlayEnactor: Error during hide animation', 'navigation/ProgressOverlayEnactor.js', error);

    } finally {
      // ✅ CRITICAL: This ALWAYS runs, even on error
      // Guarantees the overlay gets hidden no matter what
      this.endResumeCurtain(); // belt: a hidden overlay must never keep curtain state
      if (this.overlay) {
        this.overlay.style.display = 'none';
        this.overlay.style.visibility = 'hidden';
      }

      // Re-enable contenteditable if it was disabled
      if (this.wasContentEditable) {
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
          mainContent.setAttribute('contenteditable', 'true');
          verbose.debug('ProgressOverlayEnactor: Re-enabled contenteditable on .main-content', 'navigation/ProgressOverlayEnactor.js');
        }
        this.wasContentEditable = false;
      }

      this.state = 'hidden';
      this.visibleSince = null;
      verbose.debug('ProgressOverlayEnactor: Overlay hidden', 'navigation/ProgressOverlayEnactor.js');
    }
  }

  /**
   * Force hide immediately without animation
   * Use this as a last resort / emergency hide
   *
   * This is synchronous and bypasses all state checks
   */
  static forceHide() {
    this.init();

    verbose.debug('ProgressOverlayEnactor.forceHide: Emergency hide triggered', 'navigation/ProgressOverlayEnactor.js');

    if (this.resumeCurtain) {
      this.endResumeCurtain(); // belt: a hidden overlay must never keep curtain state
      // Release the gate too, or NavigationManager stalls on completion()
      // until the 4s cap. Dynamic import: RevealGate statically imports us.
      void import('./RevealGate').then(({ RevealGate }) => RevealGate.disarm());
    }
    if (this.overlay) {
      this.overlay.style.display = 'none';
      this.overlay.style.visibility = 'hidden';
      this.overlay.style.opacity = '0';
    }

    // Re-enable contenteditable if it was disabled
    if (this.wasContentEditable) {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.setAttribute('contenteditable', 'true');
        verbose.debug('ProgressOverlayEnactor: Re-enabled contenteditable on .main-content', 'navigation/ProgressOverlayEnactor.js');
      }
      this.wasContentEditable = false;
    }

    this.state = 'hidden';
    this.visibleSince = null;
    this.hidePromise = null;

    verbose.debug('ProgressOverlayEnactor: Force hidden complete', 'navigation/ProgressOverlayEnactor.js');
  }

  /**
   * Check if overlay is currently visible
   */
  static isVisible() {
    return this.state === 'visible' || this.state === 'hiding';
  }

  /**
   * Get current state for debugging
   */
  static getState() {
    return {
      state: this.state,
      overlayExists: !!this.overlay,
      overlayDisplay: this.overlay?.style.display,
      overlayVisibility: this.overlay?.style.visibility,
      progressWidth: this.progressBar?.style.width,
      isHiding: !!this.hidePromise
    };
  }

  /**
   * Debug method - logs current state (always visible for explicit debug calls)
   */
  static debug() {
    console.log('📊 ProgressOverlayEnactor Debug:', this.getState()); // Keep as console.log for explicit debug call
  }
}

// Expose to window for debugging in console
if (typeof window !== 'undefined') {
  (window as any).ProgressOverlayEnactor = ProgressOverlayEnactor;
  (window as any).debugOverlay = () => ProgressOverlayEnactor.debug();
  (window as any).forceHideOverlay = () => ProgressOverlayEnactor.forceHide();
}
