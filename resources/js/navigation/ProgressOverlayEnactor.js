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
    if (this.overlay) return; // Already initialized

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
      console.warn('⚠️ ProgressOverlayEnactor: initial-navigation-overlay element not found in DOM');
      return;
    }

    // 🔥 CRITICAL FIX: Use getComputedStyle to detect actual visibility
    // This handles both inline styles and CSS defaults correctly
    const computedDisplay = window.getComputedStyle(this.overlay).display;
    const isCurrentlyVisible = computedDisplay !== 'none';

    if (isCurrentlyVisible) {
      this.state = 'visible';
      console.log('✅ ProgressOverlayEnactor: Bound to overlay (currently VISIBLE)');
    } else {
      this.state = 'hidden';
      console.log('✅ ProgressOverlayEnactor: Bound to overlay (currently HIDDEN)');
    }
  }

  /**
   * Rebind to DOM elements after body replacement
   * Call this after SPA navigation that swaps body content
   */
  static rebind() {
    console.log('🔄 ProgressOverlayEnactor: Rebinding to DOM after body replacement');
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
      console.log('📊 ProgressOverlayEnactor.show: Hide in progress, skipping show');
      return;
    }

    // Already visible? Just update progress
    if (this.state === 'visible') {
      console.log('📊 ProgressOverlayEnactor.show: Already visible, updating progress');
      this.update(percent, message);
      return;
    }

    console.log(`📊 ProgressOverlayEnactor.show: Showing overlay (${percent}% - ${message}, block: ${blockInteractions})`);

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
          console.log('📊 ProgressOverlayEnactor: Disabled contenteditable on .main-content');
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
          console.log('📊 ProgressOverlayEnactor: Re-enabled contenteditable on .main-content');
        }
        this.wasContentEditable = false;
      }

      this.state = 'hidden';
      console.log('✅ ProgressOverlayEnactor: Overlay hidden');
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

    console.log('💥 ProgressOverlayEnactor.forceHide: Emergency hide triggered');

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
        console.log('📊 ProgressOverlayEnactor: Re-enabled contenteditable on .main-content');
      }
      this.wasContentEditable = false;
    }

    this.state = 'hidden';
    this.hidePromise = null;

    console.log('✅ ProgressOverlayEnactor: Force hidden complete');
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
   * Debug method - logs current state
   */
  static debug() {
    console.log('📊 ProgressOverlayEnactor Debug:', this.getState());
  }
}

// Expose to window for debugging in console
if (typeof window !== 'undefined') {
  window.ProgressOverlayEnactor = ProgressOverlayEnactor;
  window.debugOverlay = () => ProgressOverlayEnactor.debug();
  window.forceHideOverlay = () => ProgressOverlayEnactor.forceHide();
}
