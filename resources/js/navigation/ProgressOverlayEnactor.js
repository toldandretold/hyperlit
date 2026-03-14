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

import { verbose } from '../utilities/logger.js';

export class ProgressOverlayEnactor {
  // DOM element references
  static overlay = null;
  static progressBar = null;
  static progressText = null;
  static progressDetails = null;

  // State machine
  static state = 'hidden'; // 'hidden' | 'visible' | 'hiding'

  // Hide operation promise (for preventing concurrent hides)
  static hidePromise = null;

  // Track contenteditable state
  static wasContentEditable = false;

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
      console.warn('⚠️ ProgressOverlayEnactor: overlay not found in DOM, recreating');
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
      verbose.debug('ProgressOverlayEnactor: Bound to overlay (currently VISIBLE)', 'navigation/ProgressOverlayEnactor.js');
    } else {
      this.state = 'hidden';
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
      console.warn('⚠️ ProgressOverlayEnactor.show: No overlay element available');
      return;
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
  static update(percent, message = null) {
    this.init();

    if (this.progressBar) {
      // Ensure progress never goes below 5% (visual feedback)
      const adjustedPercent = Math.max(5, Math.min(100, percent));
      this.progressBar.style.width = adjustedPercent + '%';
    }

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
      console.warn('⚠️ ProgressOverlayEnactor.hide: No overlay element available');
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
      console.error('❌ ProgressOverlayEnactor: Error during hide animation:', error);

    } finally {
      // ✅ CRITICAL: This ALWAYS runs, even on error
      // Guarantees the overlay gets hidden no matter what
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
  window.ProgressOverlayEnactor = ProgressOverlayEnactor;
  window.debugOverlay = () => ProgressOverlayEnactor.debug();
  window.forceHideOverlay = () => ProgressOverlayEnactor.forceHide();
}
