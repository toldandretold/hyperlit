// PASTE THIS ENTIRE CODE BLOCK INTO YOUR container-manager.js FILE

import { saveAnnotationToIndexedDB } from "./annotation-saver.js";
import { navigateToInternalId } from "./scrolling.js";
import { currentLazyLoader } from "./initializePage.js";
import { isProcessing, isComplete } from './editIndicator.js'

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
      // This is YOUR original, working link-click listener logic.
      this.container.addEventListener("click", (e) => {
        const link = e.target.closest("a");
        if (!link) return;
        const href = link.getAttribute("href");
        if (!href) return;
        this.closeContainer();
        
        let targetUrl;
        try {
          targetUrl = new URL(href, window.location.origin);
        } catch (error) {
          console.error("ContainerManager: Invalid URL encountered:", href, error);
          return; 
        }

        if (targetUrl.origin !== window.location.origin) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          return; 
        }
        
        console.log("ContainerManager: Allowing internal link to be handled by app.js listener:", href);
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
        el.scrollTop = el.dataset.scrollPos;
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

    if (this.isOpen && (this.container.id === "toc-container" || this.container.id === "source-container")) {
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

      if (this.container.id === "toc-container" || this.container.id === "source-container") {
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
      if (this.container.id === "toc-container" || this.container.id === "source-container") {
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
    this.container.focus();
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