// PASTE THIS ENTIRE CODE BLOCK INTO YOUR container-manager.js FILE

import { saveAnnotationToIndexedDB } from "./annotation-saver.js";
import { navigateToInternalId } from "./scrolling.js";
import { currentLazyLoader } from "./initializePage.js";
import { isProcessing, isComplete } from './editIndicator.js'
import { book } from './app.js';

export class ContainerManager {
  constructor(containerId, overlayId, buttonId = null, frozenContainerIds = []) {
    // 1. Store the IDs. This is the only thing the constructor should do.
    // It runs only once when the app first loads.
    this.containerId = containerId;
    this.overlayId = overlayId;
    this.buttonId = buttonId;
    this.frozenContainerIds = frozenContainerIds;
    this.isOpen = false;

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
    console.log(`Rebinding elements and listeners for manager of #${this.containerId}`);
    
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
        // Link navigation is now handled by the centralized handler in lazyLoaderFactory
        // This handler only manages container-specific behavior
        
        // ContainerManager no longer handles automatic closing based on links
        // All link navigation and container state management is handled by:
        // - unified-container.js for hyperlit content
        // - LinkNavigationHandler.js for navigation routing
        // ContainerManager only handles explicit user close actions
        
        // Handle other container-specific click behavior here if needed
        console.log(`🔗 ContainerManager: Non-link click in container`, e.target, e.target.id, e.target.tagName);
      };
      
      this.container.addEventListener("click", this.containerClickHandler);
    }

    // If the overlay exists, set up its click handler
    if (this.overlay) {
      this.overlayClickHandler = (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log(`🔗 ContainerManager: Overlay clicked for #${this.containerId}`);
        if (this.isOpen) {
          this.closeContainer();
        }
      };
      
      this.overlay.addEventListener("click", this.overlayClickHandler);
    }

    // If the button exists, set up its click handler
    if (this.button) {
      console.log(`🔧 ContainerManager: Setting up click handler for button #${this.buttonId}`);
      console.log(`🔧 Button element:`, this.button);
      
      this.buttonClickHandler = (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log(`🔗 ContainerManager: Button clicked for #${this.containerId}`);
        this.toggleContainer();
      };
      
      this.button.addEventListener("click", this.buttonClickHandler);
      console.log(`✅ ContainerManager: Click handler attached to #${this.buttonId}`);
    } else {
      console.warn(`❌ ContainerManager: Button #${this.buttonId} not found during rebind`);
    }

    // Reset container state after rebinding
    this.resetContainerState();
    
    console.log(`Rebind complete. Found container:`, this.container, `Found button:`, this.button);
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
      console.log(`🔄 Container state preserved as OPEN for #${this.containerId}`);
    } else {
      // Container was closed - ensure closed state
      this.container.classList.add('hidden');
      this.container.classList.remove('open');
      this.isOpen = false;
      console.log(`🔄 Container state reset to CLOSED for #${this.containerId}`);
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
    
    if (navButtons) this.navElementsState.navButtons = !navButtons.classList.contains("hidden-nav");
    if (logoContainer) this.navElementsState.logoContainer = !logoContainer.classList.contains("hidden-nav");
    if (topRightContainer) this.navElementsState.topRightContainer = !topRightContainer.classList.contains("hidden-nav");
    if (userButtonContainer) this.navElementsState.userButtonContainer = !userButtonContainer.classList.contains("hidden-nav");
    
    console.log("Saved nav elements state:", this.navElementsState);
  }
  
  restoreNavElementsState() {
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const userButtonContainer = document.getElementById("userButtonContainer");
    
    if (navButtons) navButtons.classList.toggle("hidden-nav", !this.navElementsState.navButtons);
    if (logoContainer) logoContainer.classList.toggle("hidden-nav", !this.navElementsState.logoContainer);
    if (userButtonContainer) userButtonContainer.classList.toggle("hidden-nav", !this.navElementsState.userButtonContainer);
    
    console.log("Restored nav elements state:", this.navElementsState);
  }

  _applyTopRightVisibility() {
    const topRight = document.getElementById("topRightContainer");
    if (!topRight) return;

    if (this.isOpen && this.container.id === "source-container") {
      topRight.classList.toggle("hidden-nav", !this.navElementsState.topRightContainer);
    } else {
      topRight.classList.remove("hidden-nav");
    }
  }

  updateState() {
    console.log("updateState: isOpen =", this.isOpen, "container.id =", this.container.id);
    if (this.isOpen) {
      this.container.classList.add("open");
      this.overlay.classList.add("active");
      this.frozenElements.forEach((el) => this.freezeElement(el));

      if (this.container.id === "source-container") {
        this.saveNavElementsState();
        const navButtons = document.getElementById("nav-buttons");
        const logoContainer = document.getElementById("logoContainer");
        const userButtonContainer = document.getElementById("userButtonContainer");
        if (navButtons) navButtons.classList.add("hidden-nav");
        if (logoContainer) logoContainer.classList.add("hidden-nav");
        if (userButtonContainer) userButtonContainer.classList.add("hidden-nav");
      }
    } else {
      this.container.classList.remove("open");
      this.overlay.classList.remove("active");
      this.frozenElements.forEach((el) => this.unfreezeElement(el));
      if (this.container.id === "source-container") {
        this.restoreNavElementsState();
      }
    }
  }

  openContainer(content = null, highlightId = null) {
    if (content && this.container) this.container.innerHTML = content;
    else if (this.initialContent && this.container) this.container.innerHTML = this.initialContent;
    
    if (highlightId) this.highlightId = highlightId;
    if (window.containerCustomizer) window.containerCustomizer.loadCustomizations();
    
    this.container.classList.remove("hidden");
    this.container.classList.add("open");
    this.isOpen = true;
    window.activeContainer = this.container.id;
    
    if (this.container.id === "toc-container") {
      this.saveNavElementsState();
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const userButtonContainer = document.getElementById("userButtonContainer");
      if (navButtons) navButtons.classList.add("hidden-nav");
      if (logoContainer) logoContainer.classList.add("hidden-nav");
      if (userButtonContainer) userButtonContainer.classList.add("hidden-nav");
    }
    
    this.updateState();
    
    // Only focus the container if it's not a back button navigation
    // to avoid interfering with browser navigation
    if (!this.isBackNavigation) {
      this.container.focus();
    }
  }

  closeContainer() {
    if (this.container) {
      this.container.style.left = '';
      this.container.style.top = '';
      this.container.style.right = '';
      this.container.style.bottom = '';
      this.container.style.transform = '';
    }
    
    if (this.container.id === "highlight-container" && this.highlightId) {
      // ... existing highlight saving code ...
    } 

    this.container.style.visibility = "hidden";
    this.isOpen = false;
    window.activeContainer = "main-content";
    
    if (this.container.id === "toc-container") {
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const userButtonContainer = document.getElementById("userButtonContainer");
      if (navButtons) navButtons.classList.remove("hidden-nav");
      if (logoContainer) logoContainer.classList.remove("hidden-nav");
      if (userButtonContainer) userButtonContainer.classList.remove("hidden-nav");
    }
    
    // Handle hyperlit container URL cleanup when closing via overlay/direct close
    if (this.container.id === "hyperlit-container") {
      const currentUrl = window.location;
      if (currentUrl.hash && (currentUrl.hash.startsWith('#HL_') || currentUrl.hash.startsWith('#hypercite_') || 
                             currentUrl.hash.startsWith('#footnote_') || currentUrl.hash.startsWith('#citation_'))) {
        // Remove hyperlit-related hash from URL
        const cleanUrl = `${currentUrl.pathname}${currentUrl.search}`;
        console.log('🔗 ContainerManager: Cleaning up hyperlit hash from URL:', currentUrl.hash, '→', cleanUrl);
        
        // Push new clean state to history
        const currentState = history.state || {};
        const newState = {
          ...currentState,
          hyperlitContainer: null // Clear container state
        };
        history.pushState(newState, '', cleanUrl);
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
    console.log('🔗 ContainerManager: Skipping URL cleanup - handled by unified container');
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
    console.log(`🧹 ContainerManager: Destroying manager for #${this.containerId}`);
    
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
    
    console.log(`✅ ContainerManager: Destroyed manager for #${this.containerId}`);
  }
}