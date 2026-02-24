// PASTE THIS ENTIRE CODE BLOCK INTO YOUR containerManager.js FILE

import { saveAnnotationToIndexedDB } from "./hyperlights/index.js";
import { navigateToInternalId } from "./scrolling.js";
import { currentLazyLoader } from "./initializePage.js";
import { isProcessing, isComplete } from './components/editIndicator.js'
import { book } from './app.js';
import { closeHyperlitContainer } from './hyperlitContainer/index.js';

export class ContainerManager {
  constructor(containerId, overlayId, buttonId = null, frozenContainerIds = [], options = {}) {
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
    
    // Store old element references for cleanup
    const oldContainer = this.container;
    const oldOverlay = this.overlay;
    const oldButton = this.button;
    
    // Find all the elements using the stored IDs
    this.container = document.getElementById(this.containerId);
    this.overlay = document.getElementById(this.overlayId);
    this.button = this.buttonId ? document.getElementById(this.buttonId) : null;
    this.frozenElements = this.frozenContainerIds.map(id => document.getElementById(id)).filter(Boolean);
    
    // Clean up old event listeners if elements have changed
    if (oldContainer && oldContainer !== this.container && this.containerClickHandler) {
      oldContainer.removeEventListener("click", this.containerClickHandler);
    }
    if (oldOverlay && oldOverlay !== this.overlay && this.overlayClickHandler) {
      oldOverlay.removeEventListener("click", this.overlayClickHandler);
    }
    if (oldButton && oldButton !== this.button && this.buttonClickHandler) {
      oldButton.removeEventListener("click", this.buttonClickHandler);
    }

    // If the container exists, store its initial content and set up its internal link listener
    if (this.container) {
      this.initialContent = this.container.innerHTML;
      
      // Create and store container click handler
      this.containerClickHandler = (e) => {
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
      this.overlayClickHandler = async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (this.isOpen) {
          // Use specialized close function for hyperlit-container to unlock body scroll
          if (this.containerId === 'hyperlit-container') {
            await closeHyperlitContainer();
          } else {
            this.closeContainer();
          }
        }
      };

      this.overlay.addEventListener("click", this.overlayClickHandler);
    }

    // If the button exists, set up its click handler
    if (this.button) {
      this.buttonClickHandler = (e) => {
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
  freezeElement(el) {
    if (el) {
      el.dataset.scrollPos = el.scrollTop;
      el.style.pointerEvents = "none";
      el.style.overflow = "hidden";
    }
  }

  unfreezeElement(el) {
    if (el) {
      el.style.pointerEvents = "";
      el.style.overflow = "";
      if (el.dataset.scrollPos) {
        // 🚨 DEBUG: Log container manager scroll restoration
        console.log(`🔧 CONTAINER MANAGER: Would restore scroll position to ${el.dataset.scrollPos}, but checking for active navigation...`);
        
        // Check if we're currently navigating - if so, don't restore scroll position
        const mainContent = document.getElementById('test555yeah') || document.querySelector('.main-content');
        if (mainContent && window.currentLazyLoader && window.currentLazyLoader.scrollLocked) {
          console.log(`🔧 CONTAINER MANAGER: SKIPPING scroll restoration - navigation in progress`);
        } else {
          console.log(`🔧 CONTAINER MANAGER: Applying scroll restoration to ${el.dataset.scrollPos}`);
          console.trace("Container manager scroll restoration source:");
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
    
    console.log("Saved nav elements state:", this.navElementsState);
  }
  
  restoreNavElementsState() {
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const userButtonContainer = document.getElementById("userButtonContainer");
    
    if (navButtons) navButtons.classList.toggle("perimeter-hidden", !this.navElementsState.navButtons);
    if (logoContainer) logoContainer.classList.toggle("perimeter-hidden", !this.navElementsState.logoContainer);
    if (userButtonContainer) userButtonContainer.classList.toggle("perimeter-hidden", !this.navElementsState.userButtonContainer);
    
    console.log("Restored nav elements state:", this.navElementsState);
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
      this.overlay.classList.add("active");
      this.frozenElements.forEach((el) => this.freezeElement(el));
    } else {
      this.container.classList.remove("open");
      this.overlay.classList.remove("active");
      this.frozenElements.forEach((el) => this.unfreezeElement(el));
    }
  }

  openContainer(content = null, highlightId = null) {
    if (content && this.container) this.container.innerHTML = content;
    else if (this.initialContent && this.container) this.container.innerHTML = this.initialContent;

    if (highlightId) this.highlightId = highlightId;
    if (window.containerCustomizer) window.containerCustomizer.loadCustomizations();

    // Clear any inline styles that might interfere
    this.container.style.visibility = '';
    this.container.style.transform = '';

    this.container.classList.remove("hidden");
    this.container.classList.add("open");
    this.isOpen = true;
    window.activeContainer = this.container.id;

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

    // Call onOpen callback if provided (after innerHTML replacement)
    if (this.onOpenCallback) {
      this.onOpenCallback();
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
    window.activeContainer = "main-content";

    if (this.container.id === "toc-container") {
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const userButtonContainer = document.getElementById("userButtonContainer");
      if (navButtons) navButtons.classList.remove("perimeter-hidden");
      if (logoContainer) logoContainer.classList.remove("perimeter-hidden");
      if (userButtonContainer) userButtonContainer.classList.remove("perimeter-hidden");
    }

    // Handle hyperlit container URL cleanup when closing via overlay/direct close
    if (this.container.id === "hyperlit-container") {
      const currentUrl = window.location;
      if (currentUrl.hash && (currentUrl.hash.startsWith('#HL_') || currentUrl.hash.startsWith('#hypercite_') ||
                             currentUrl.hash.startsWith('#footnote_') || currentUrl.hash.startsWith('#citation_'))) {
        // Remove hyperlit-related hash from URL
        const cleanUrl = `${currentUrl.pathname}${currentUrl.search}`;

        // Push new clean state to history
        const currentState = history.state || {};
        const newState = {
          ...currentState,
          hyperlitContainer: null // Clear container state
        };
        history.replaceState(newState, '', cleanUrl);
      }
    }

    this.updateState();
    this.container.classList.remove("open");
    this.container.classList.add("hidden");
    this.container.style.visibility = "";
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
      this.overlayClickHandler = null;
    }

    if (this.button && this.buttonClickHandler) {
      this.button.removeEventListener("click", this.buttonClickHandler);
      this.buttonClickHandler = null;
    }

    // Close container if it's open
    if (this.isOpen) {
      this.closeContainer();
    }

    // Clear references
    this.container = null;
    this.overlay = null;
    this.button = null;
    this.frozenElements = [];
  }
}