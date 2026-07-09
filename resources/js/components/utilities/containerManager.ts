
// (Removed dead upward imports of hyperlights/index, scrolling and pageLoad: none were used —
// the only currentLazyLoader reference is `(window as any).currentLazyLoader`. They put this base class,
// which 5+ components `extends`, into an import cycle that TDZ-crashed the bundle at init.)
import { isProcessing, isComplete } from '../cloudRef/editIndicator'
import { book } from '../../app';
import { verbose } from '../../utilities/logger'
import { pushModal, popModal, isTopModal } from '../../utilities/modalState'

// Modal-style panels (their overlay blurs/blocks the page): while open, Tab is
// trapped inside the container, Escape closes it, and focus returns to the
// element that opened it (WCAG 2.1.2 / 2.4.3 — keyboard focus must not wander
// the inert background, and keyboard users need a non-pointer way out).
// hyperlit-container is deliberately NOT here: it hosts sub-book content with
// its own history-driven close and edit-mode keyboard semantics.
const FOCUS_TRAP_CONTAINER_IDS = new Set([
  'user-container',
  'newbook-container',
  'settings-container',
  'source-container',
  'toc-container',
]);

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class ContainerManager {
  [key: string]: any;
  constructor(containerId: any, overlayId: any, buttonId: any = null, frozenContainerIds: any = [], options: any = {}) {
    // 1. Store the IDs. This is the only thing the constructor should do.
    // It runs only once when the app first loads.
    this.containerId = containerId;
    this.overlayId = overlayId;
    this.buttonId = buttonId;
    this.frozenContainerIds = frozenContainerIds;
    this.isOpen = false;

    // Store callbacks
    this.onOpenCallback = options.onOpen || null;

    // Your original properties are preserved
    this.navElementsState = {
      navButtons: true,
      logoContainer: true,
      topRightContainer: true,
      userButtonContainer: true
    };
    this.highlightId = null;

    // 2. Call the rebind method ONCE to set everything up for the initial page load.
    this.rebindElements();
  }

  // =================================================================
  // THIS IS THE NEW METHOD, BUILT FROM YOUR ORIGINAL CONSTRUCTOR.
  // It finds the elements AND attaches the listeners. It can be called
  // again and again to "refresh" the manager after an SPA transition.
  // =================================================================
  rebindElements() {
    // Reset any stale drag/resize state from before SPA navigation
    if ((window as any).containerDragger) (window as any).containerDragger.reset();

    // Store old element references for cleanup
    const oldContainer = this.container;
    const oldOverlay = this.overlay;
    const oldButton = this.button;
    
    // Find all the elements using the stored IDs
    this.container = document.getElementById(this.containerId);
    this.overlay = document.getElementById(this.overlayId);
    this.button = this.buttonId ? document.getElementById(this.buttonId) : null;
    this.frozenElements = this.frozenContainerIds.map((id: any) => document.getElementById(id)).filter(Boolean);
    
    // Always remove old handlers before creating new ones.
    // The old check (oldEl !== this.el) missed the case where the DOM element is the
    // same but rebindElements() is called again — a new handler function was created and
    // addEventListener'd without removing the previous one, causing accumulation.
    if (this.containerClickHandler) {
      if (oldContainer) oldContainer.removeEventListener("click", this.containerClickHandler);
      if (this.container && this.container !== oldContainer) this.container.removeEventListener("click", this.containerClickHandler);
    }
    if (this.overlayClickHandler) {
      if (oldOverlay) oldOverlay.removeEventListener("click", this.overlayClickHandler);
      if (this.overlay && this.overlay !== oldOverlay) this.overlay.removeEventListener("click", this.overlayClickHandler);
    }
    if (this.buttonClickHandler) {
      if (oldButton) oldButton.removeEventListener("click", this.buttonClickHandler);
      if (this.button && this.button !== oldButton) this.button.removeEventListener("click", this.buttonClickHandler);
    }

    // If the container exists, store its initial content and set up its internal link listener
    if (this.container) {
      this.initialContent = this.container.innerHTML;
      
      // Create and store container click handler
      this.containerClickHandler = (e: any) => {
        // This handler is intentionally left sparse for link clicks.
        // Link navigation is managed by a global, layered system to support SPA functionality.
        // This container-specific handler should only contain logic for non-navigation clicks.

        /*
         * ## Link Handling Architecture ##
         *
         * 1. Global Listener ('lazyLoaderFactory.js'):
         *    - A global 'click' event listener is attached to the document.
         *    - It acts as the primary entry point for all link clicks, delegating them to the central router.
         *
         * 2. Central Router ('navigation/LinkNavigationHandler.js'):
         *    - This module is the core of navigation. It inspects the link's destination.
         *    - It determines whether the navigation is within the same book (e.g., to an anchor),
         *      a transition to another book, or a link that should be ignored by the SPA router (e.g., external links).
         *
         * 3. In-Container Handlers ('unifiedContainer.js'):
         *    - Specific containers, particularly the '#hyperlit-container' which shows footnotes, highlights, etc.,
         *      have their own link click handlers for links *within* them.
         *    - These handlers provide context-specific behavior (like closing the container) before
         *      using the Central Router ('LinkNavigationHandler') to execute the navigation.
         *
         * This 'ContainerManager' class is generic and does not handle link-based navigation itself.
         * That logic is centralized to ensure consistent SPA behavior across the application.
        */
        
        // Handle other container-specific click behavior here if needed
        // console.log(`🔗 ContainerManager: Non-link click in container`, e.target, e.target.id, e.target.tagName);
      }; 
      
      this.container.addEventListener("click", this.containerClickHandler);
    }

    // If the overlay exists, set up its click handler
    if (this.overlay) {
      // Remove any handler previously anchored to this overlay for this containerId.
      // This catches orphaned handlers from destroyed instances whose reference chain broke.
      const handlerKey = `_cmOverlayHandler_${this.containerId}`;
      if (this.overlay[handlerKey]) {
        this.overlay.removeEventListener("click", this.overlay[handlerKey]);
      }

      this.overlayClickHandler = async (e: any) => {
        e.stopPropagation();
        e.preventDefault();
        if (!this.isOpen || this._closePending) return;
        console.log(`[Overlay] click handler fired. containerId=${this.containerId}`);
        this._closePending = true;
        try {
          // For hyperlit-container: each open pushed a history entry, so
          // closing should *consume* that entry by going back. The popstate
          // handler's fast-path then runs popTopLayer / closeHyperlitContainer
          // to update the DOM, which internally flushes pending saves. This
          // keeps browser history aligned with the visible stack so
          // back/forward behaves as the user expects (one container per step).
          if (this.containerId === 'hyperlit-container') {
            const { isStackPopPending } = await import('../../hyperlitContainer/stack');
            if (isStackPopPending()) {
              console.warn('Overlay click BLOCKED — pop already in flight');
              return;
            }
            // Flush any pending saves before navigating away from this state,
            // but ONLY in edit mode — a read-mode close has no pending user
            // changes and must not run the save path (the popstate teardown's
            // popTopLayer applies the same edit-mode guard).
            try {
              const { getHyperlitEditMode } = await import('../../hyperlitContainer/core');
              if (getHyperlitEditMode()) {
                const { flushPendingEdits } = await import('../../utilities/pendingEditsRegistry');
                await flushPendingEdits();
              }
            } catch (err) {
              console.warn('Pre-back flush failed (non-fatal):', err);
            }
            // Normally, closing the base container consumes the history entry that opening it
            // pushed — history.back() peels it. But a rapid back/forward burst can leave the
            // CURRENT entry's container belonging to a DIFFERENT book than the one on screen: a
            // stale async restoration replaceState-stamps another book's containerStack onto this
            // book's URL entry (containerStackBookId mismatch), or the container is a DOM-only
            // wedge with no matching entry (containerStackBookId null). history.back() there does
            // NOT close-in-place — it TELEPORTS to that other book (the "close a hypercite and it
            // jumps me to a different book / can't get home" glitch). Only go back when the entry's
            // container actually belongs to the rendered book; otherwise close in place (a pure
            // replaceState in closeHyperlitContainer — no navigation).
            const renderedBookId = (document.querySelector('main.main-content') as any)?.id || null;
            const stateBookId = history.state?.containerStackBookId || null;
            if (stateBookId && renderedBookId && stateBookId === renderedBookId) {
              history.back();
            } else {
              const { closeHyperlitContainer } = await import('../../hyperlitContainer/core');
              await closeHyperlitContainer();
            }
          } else {
            this.closeContainer();
          }
        } finally {
          this._closePending = false;
        }
      };

      // Anchor the handler on the DOM element so any future instance can find and remove it
      this.overlay[handlerKey] = this.overlayClickHandler;
      this.overlay.addEventListener("click", this.overlayClickHandler);
    }

    // hyperlit-container: Escape = the overlay-click close (history-driven —
    // consumes the history entry; the popstate fast-path pops the top layer,
    // flushing edit-mode saves exactly like an overlay click). WCAG 2.1.2:
    // keyboard users otherwise had no way out of a footnote/highlight.
    // Bubble phase on purpose: capture-phase focus traps stacked above
    // (settings, dialogs) stopImmediatePropagation their Escape first.
    if (this.containerId === 'hyperlit-container') {
      if (this._hyperlitEscapeHandler) {
        document.removeEventListener('keydown', this._hyperlitEscapeHandler);
      }
      this._hyperlitEscapeHandler = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        if (!this.container?.classList.contains('open')) return;
        this.overlayClickHandler?.(e);
      };
      document.addEventListener('keydown', this._hyperlitEscapeHandler);
    }

    // If the button exists, set up its click handler
    if (this.button) {
      this.buttonClickHandler = (e: any) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleContainer();
      };

      this.button.addEventListener("click", this.buttonClickHandler);
    }

    // Reset container state after rebinding
    this.resetContainerState();
    
    //console.log(`Rebind complete. Found container:`, this.container, `Found button:`, this.button);
  }
  
  /**
   * Reset container to its initial closed state
   * Call this after SPA transitions to clear any stale CSS state
   */
  resetContainerState() {
    if (!this.container) return;
    
    // Preserve current open state by checking DOM classes
    const wasOpen = this.container.classList.contains('open');
    
    // Reset all inline styles that might interfere with proper opening
    this.container.style.display = '';
    this.container.style.opacity = '';
    this.container.style.width = '';
    this.container.style.height = '';
    this.container.style.visibility = '';
    this.container.style.padding = '';
    this.container.style.transform = '';
    this.container.style.top = '';
    this.container.style.left = '';
    
    if (wasOpen) {
      // Container was open - preserve open state
      this.container.classList.remove('hidden');
      this.container.classList.add('open');
      this.isOpen = true;
    } else {
      // Container was closed - ensure closed state
      this.container.classList.add('hidden');
      this.container.classList.remove('open');
      this.isOpen = false;
    }
  }

  // =================================================================
  // ALL YOUR OTHER METHODS ARE PRESERVED HERE, UNCHANGED.
  // =================================================================
  freezeElement(el: any) {
    if (el) {
      el.dataset.scrollPos = el.scrollTop;
      el.style.pointerEvents = "none";
      el.style.overflow = "hidden";
    }
  }

  unfreezeElement(el: any) {
    if (el) {
      el.style.pointerEvents = "";
      el.style.overflow = "";
      if (el.dataset.scrollPos) {
        
        // Check if we're currently navigating - if so, don't restore scroll position
        const mainContent = document.getElementById('test555yeah') || document.querySelector('.main-content');
        if (mainContent && (window as any).currentLazyLoader && (window as any).currentLazyLoader.scrollLocked) {
        } else {
          verbose.content(`🔧 CONTAINER MANAGER: Applying scroll restoration to ${el.dataset.scrollPos}`, 'components/utilities/ContainerManager.ts');
          el.scrollTop = el.dataset.scrollPos;
        }
        delete el.dataset.scrollPos;
      }
    }
  }

  saveNavElementsState() {
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const topRightContainer = document.getElementById("topRightContainer");
    const userButtonContainer = document.getElementById("userButtonContainer");
    
    if (navButtons) this.navElementsState.navButtons = !navButtons.classList.contains("perimeter-hidden");
    if (logoContainer) this.navElementsState.logoContainer = !logoContainer.classList.contains("perimeter-hidden");
    if (topRightContainer) this.navElementsState.topRightContainer = !topRightContainer.classList.contains("perimeter-hidden");
    if (userButtonContainer) this.navElementsState.userButtonContainer = !userButtonContainer.classList.contains("perimeter-hidden");
    
  }
  
  restoreNavElementsState() {
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const userButtonContainer = document.getElementById("userButtonContainer");
    
    if (navButtons) navButtons.classList.toggle("perimeter-hidden", !this.navElementsState.navButtons);
    if (logoContainer) logoContainer.classList.toggle("perimeter-hidden", !this.navElementsState.logoContainer);
    if (userButtonContainer) userButtonContainer.classList.toggle("perimeter-hidden", !this.navElementsState.userButtonContainer);
  }

  _applyTopRightVisibility() {
    const topRight = document.getElementById("topRightContainer");
    if (!topRight) return;

    if (this.isOpen && this.container.id === "source-container") {
      topRight.classList.toggle("perimeter-hidden", !this.navElementsState.topRightContainer);
    } else {
      topRight.classList.remove("perimeter-hidden");
    }
  }

  updateState() {
    if (this.isOpen) {
      this.container.classList.add("open");
      if (this.overlay) this.overlay.classList.add("active");
      this.frozenElements.forEach((el: any) => this.freezeElement(el));
    } else {
      this.container.classList.remove("open");
      if (this.overlay) this.overlay.classList.remove("active");
      this.frozenElements.forEach((el: any) => this.unfreezeElement(el));
    }
  }

  openContainer(content = null, highlightId = null, { skipContentReset = false } = {}) {
    if (!skipContentReset) {
      if (content && this.container) this.container.innerHTML = content;
      else if (this.initialContent && this.container) this.container.innerHTML = this.initialContent;
    }

    if (highlightId) this.highlightId = highlightId;
    if ((window as any).containerCustomizer) (window as any).containerCustomizer.loadCustomizations();

    // Clear any inline styles that might interfere
    this.container.style.visibility = '';
    this.container.style.transform = '';

    this.container.classList.remove("hidden");
    this.container.classList.add("open");
    this.isOpen = true;
    (window as any).activeContainer = this.container.id;

    if (this.container.id === "toc-container") {
      this.saveNavElementsState();
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const userButtonContainer = document.getElementById("userButtonContainer");
      if (navButtons) navButtons.classList.add("perimeter-hidden");
      if (logoContainer) logoContainer.classList.add("perimeter-hidden");
      if (userButtonContainer) userButtonContainer.classList.add("perimeter-hidden");
    }

    this.updateState();

    // Only focus the container if it's not a back button navigation
    // to avoid interfering with browser navigation
    if (!this.isBackNavigation) {
      this.container.focus();
    }

    this._engageFocusTrap();

    // Call onOpen callback if provided (after innerHTML replacement)
    if (this.onOpenCallback) {
      this.onOpenCallback();
    }
  }

  /** Trap keyboard focus inside a modal container while it is open. */
  _engageFocusTrap() {
    if (!FOCUS_TRAP_CONTAINER_IDS.has(this.containerId)) return;
    if (this._trapKeydownHandler) return; // already engaged (re-open / content refresh)

    // Remember the trigger so closeContainer can hand focus back to it.
    this._focusReturnEl = document.activeElement instanceof HTMLElement
      && !this.container.contains(document.activeElement)
      ? document.activeElement
      : null;

    // Register on the global modal stack: only the TOP trap acts on keydown,
    // so a dialog/panel opened above this container takes over Tab/Escape.
    this._modalToken = pushModal();

    // Seat focus inside the panel without popping the mobile keyboard: focus
    // the container itself (needs tabindex to be focusable), not an input.
    if (!this.container.hasAttribute('tabindex')) {
      this.container.setAttribute('tabindex', '-1');
    }
    if (!this.isBackNavigation) {
      this.container.focus();
    }

    this._trapKeydownHandler = (e: KeyboardEvent) => {
      if (!this.isOpen || !this.container) return;
      if (!this._modalToken || !isTopModal(this._modalToken)) return;

      if (e.key === 'Escape') {
        // stopImmediatePropagation: no other capture listener (stacked traps,
        // legacy Escape handlers) may also act on this press.
        e.stopImmediatePropagation();
        this.closeContainer();
        return;
      }
      if (e.key !== 'Tab') return;

      // getClientRects (offsetParent is null for position:fixed subtrees and
      // mid-boot layouts); fall back to the unfiltered list rather than
      // dead-trapping Tab when layout hasn't settled.
      const all = Array.from(this.container.querySelectorAll(FOCUSABLE_SELECTOR));
      const visible = all.filter((el: any) => el.getClientRects().length > 0);
      const focusables = visible.length > 0 ? visible : all;
      const first: any = focusables[0];
      const last: any = focusables[focusables.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      const inside = this.container.contains(active);

      if (e.shiftKey) {
        if (!inside || active === first || active === this.container) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last || active === this.container) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', this._trapKeydownHandler, true);
  }

  /** Undo _engageFocusTrap: detach the listener and restore focus to the trigger. */
  _releaseFocusTrap() {
    if (this._modalToken) {
      popModal(this._modalToken);
      this._modalToken = null;
    }
    if (this._trapKeydownHandler) {
      document.removeEventListener('keydown', this._trapKeydownHandler, true);
      this._trapKeydownHandler = null;
    }
    const returnEl = this._focusReturnEl;
    this._focusReturnEl = null;
    if (returnEl && returnEl.isConnected) {
      try { returnEl.focus(); } catch { /* non-fatal */ }
    }
  }

  closeContainer() {
    if (this.container) {
      this.container.style.left = '';
      this.container.style.top = '';
      this.container.style.right = '';
      this.container.style.bottom = '';
      this.container.style.transform = '';
      this.container.style.visibility = ''; // Clear inline visibility

      // CRITICAL FIX: Add .hidden class and remove .open class
      // This ensures bottom-up-container transforms off-screen properly
      this.container.classList.remove('open');
      this.container.classList.add('hidden');
    }

    if (this.container.id === "highlight-container" && this.highlightId) {
      // ... existing highlight saving code ...
    }

    // Don't set inline visibility - let CSS classes handle it
    this.isOpen = false;
    (window as any).activeContainer = "main-content";

    if (this.container.id === "toc-container") {
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const userButtonContainer = document.getElementById("userButtonContainer");
      if (navButtons) navButtons.classList.remove("perimeter-hidden");
      if (logoContainer) logoContainer.classList.remove("perimeter-hidden");
      if (userButtonContainer) userButtonContainer.classList.remove("perimeter-hidden");
    }

    // Clear container state from history when closing — but PRESERVE the hash.
    // The hash (#hypercite_/#HL_/#footnote_/#citation_) is the anchor of the element in the MAIN
    // text; it must stay in the history entry so back/forward returns to it. replaceState rewrites
    // the entry itself, so stripping the hash here permanently broke "click hypercite → back → take
    // me to the hypercite" — the reader fell back to a flaky saved-scroll resume and OFTEN opened at
    // the start of the book. (This was a duplicate of the strip already removed in
    // hyperlitContainer/core.ts; it fired during reader-view cleanup on every SPA book hop.)
    // Refresh-resume is handled by the scrolled-away marker in scrolling/navState, NOT by URL mutation.
    if (this.container.id === "hyperlit-container") {
      const currentUrl = window.location;
      if (currentUrl.hash && (currentUrl.hash.startsWith('#HL_') || currentUrl.hash.startsWith('#hypercite_') ||
                             currentUrl.hash.startsWith('#footnote_') || currentUrl.hash.startsWith('#citation_'))) {
        // Keep pathname + search + HASH — only the container state is cleared.
        const keepUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
        const currentState = history.state || {};
        const newState = {
          ...currentState,
          hyperlitContainer: null // Clear container state, leave the URL (incl. hash) intact
        };
        history.replaceState(newState, '', keepUrl);
      }
    }

    this.updateState();
    this.container.classList.remove("open");
    this.container.classList.add("hidden");
    this.container.style.visibility = "";
    this._releaseFocusTrap();
    this.cleanupURL();
  }

  cleanupURL() {
    // Skip URL cleanup - this is now handled by closeHyperlitContainer()
    // to ensure proper history state management
    return;

    const pathParts = window.location.pathname.split('/').filter(part => part.length > 0);
    if (pathParts.length > 0) {
      const bookName = pathParts[0];
      const newPath = '/' + bookName;
      window.history.pushState({}, document.title, newPath);
    }
  }

  toggleContainer() {
    if (this.isOpen) {
      this.closeContainer();
    } else {
      this.openContainer();
    }
  }

  /**
   * Properly destroy this container manager and clean up all event listeners
   * Call this during SPA transitions to prevent listener accumulation
   */
  destroy() {
    // Remove all event listeners
    if (this.container && this.containerClickHandler) {
      this.container.removeEventListener("click", this.containerClickHandler);
      this.containerClickHandler = null;
    }

    if (this.overlay && this.overlayClickHandler) {
      this.overlay.removeEventListener("click", this.overlayClickHandler);
      const handlerKey = `_cmOverlayHandler_${this.containerId}`;
      delete this.overlay[handlerKey];
      this.overlayClickHandler = null;
    }

    if (this.button && this.buttonClickHandler) {
      this.button.removeEventListener("click", this.buttonClickHandler);
      this.buttonClickHandler = null;
    }

    if (this._hyperlitEscapeHandler) {
      document.removeEventListener('keydown', this._hyperlitEscapeHandler);
      this._hyperlitEscapeHandler = null;
    }

    // Close container if it's open
    if (this.isOpen) {
      this.closeContainer();
    }
    this._releaseFocusTrap(); // safety: closeContainer normally releases it

    // Clear references
    this.container = null;
    this.overlay = null;
    this.button = null;
    this.frozenElements = [];
  }
}