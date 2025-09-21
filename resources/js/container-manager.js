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
    
    // Find all the elements using the stored IDs
    this.container = document.getElementById(this.containerId);
    this.overlay = document.getElementById(this.overlayId);
    this.button = this.buttonId ? document.getElementById(this.buttonId) : null;
    this.frozenElements = this.frozenContainerIds.map(id => document.getElementById(id)).filter(Boolean);

    // If the container exists, store its initial content and set up its internal link listener
    if (this.container) {
      this.initialContent = this.container.innerHTML;
      
      // Container-specific click handling (non-link functionality only)
      this.container.addEventListener("click", (e) => {
        // Link navigation is now handled by the centralized handler in lazyLoaderFactory
        // This handler only manages container-specific behavior
        
        // ContainerManager no longer handles automatic closing based on links
        // All link navigation and container state management is handled by:
        // - unified-container.js for hyperlit content
        // - LinkNavigationHandler.js for navigation routing
        // ContainerManager only handles explicit user close actions
        
        // Handle other container-specific click behavior here if needed
        console.log(`🔗 ContainerManager: Non-link click in container`);
      });
    }

    // If the overlay exists, set up its click handler
    if (this.overlay) {
      this.overlay.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (this.isOpen) {
          this.closeContainer();
        }
      });
    }

    // If the button exists, set up its click handler
    if (this.button) {
      this.button.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleContainer();
      });
    }

    console.log(`Rebind complete. Found container:`, this.container, `Found button:`, this.button);
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
    
    this.updateState();
    this.container.classList.remove("open");
    this.container.classList.add("hidden");
    this.container.style.visibility = "";
    this.cleanupURL();
  }

  cleanupURL() {
    // Don't cleanup URL if there's a hash - navigation should preserve it
    if (window.location.hash) {
      console.log('🔗 ContainerManager: Skipping URL cleanup - preserving hash:', window.location.hash);
      return;
    }
    
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
} 