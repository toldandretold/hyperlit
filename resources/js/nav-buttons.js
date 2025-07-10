// Export the NavButtons class
export default class NavButtons {
  /**
   * Options:
   * - elementIds: An array of IDs or selectors of elements to toggle (default ["nav-buttons"]).
   * - loadingElementIds: An array of IDs for elements to hide during loading.
   * - tapThreshold: Maximum movement in pixels to consider an event a tap (default 10).
   */
  constructor(options = {}) {
  // Elements to toggle on tap/click
  this.elementIds = options.elementIds || ["nav-buttons"];
  
  // Auto-detect which loading elements exist on this page
  const possibleLoadingElements = [
      "nav-buttons", 
      "topRightContainer", 
      "logoContainer",      // exists on reader page
      "userButtonContainer" // exists on home page
    ];
    
    // Only include elements that actually exist in the DOM
    this.loadingElementIds = options.loadingElementIds || 
      possibleLoadingElements.filter(id => document.getElementById(id) !== null);
    
    this.tapThreshold = options.tapThreshold || 10;
    
    // Get toggle elements
    this.elements = this.elementIds.map((id) =>
      document.getElementById(id)
    ).filter(el => el !== null);

    // Check if we found any toggle elements
    if (this.elements.length === 0) {
      console.warn('No toggle elements found');
    }
    
    // Get loading elements (only ones that exist)
    this.loadingElements = this.loadingElementIds.map((id) =>
      document.getElementById(id)
    ).filter(el => el !== null);

    console.log('NavButtons constructor:');
    console.log('- Page elements detected:', possibleLoadingElements.map(id => ({
      id,
      exists: document.getElementById(id) !== null
    })));
    console.log('- Toggle elements:', this.elements.map(el => el.id));
    console.log('- Loading elements:', this.loadingElements.map(el => el.id));

    this.startX = 0;
    this.startY = 0;
    this.isInitialized = false;

    // Detect if the device has touch support.
    this.isTouchDevice =
      "ontouchstart" in window || navigator.maxTouchPoints > 0;

    // Bind event handlers.
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.updatePosition = this.updatePosition.bind(this);
    this.handleResize = this.handleResize.bind(this);

    this.resizeDebounceTimeout = null;
  }

  /**
   * Initialize event listeners.
   */
  init() {
    console.log('NavButtons init() called');
    if (this.isTouchDevice) {
      if (window.PointerEvent) {
        document.addEventListener("pointerdown", this.handlePointerDown);
        document.addEventListener("pointerup", this.handlePointerUp);
      } else {
        document.addEventListener("touchstart", this.handlePointerDown);
        document.addEventListener("touchend", this.handlePointerUp);
      }
    } else {
      document.addEventListener("click", this.handleClick);
    }

    // Update nav-buttons position initially and on window resize.
    this.updatePosition();
    window.addEventListener("resize", this.handleResize);
  }

  /**
   * Remove event listeners.
   */ 
  destroy() {
    console.log('NavButtons destroy() called');
    if (this.isTouchDevice) {
      if (window.PointerEvent) {
        document.removeEventListener("pointerdown", this.handlePointerDown);
        document.removeEventListener("pointerup", this.handlePointerUp);
      } else {
        document.removeEventListener("touchstart", this.handlePointerDown);
        document.removeEventListener("touchend", this.handlePointerUp);
      }
    } else {
      document.removeEventListener("click", this.handleClick);
    }
    window.removeEventListener("resize", this.handleResize);
  }

  /**
   * Checks if an event should be ignored because it originates
   * from a sup.note or any interactive element.
   */
  /**
 * Checks if an event should be ignored because it originates
 * from a sup.note or any interactive element.
 */
      /**
     * Checks if an event should be ignored because it originates
     * from a sup.note or any interactive element.
     */
    shouldIgnoreEvent(event) {
  // Check if any container is active
  const activeContainer = window.uiState?.activeContainer || window.activeContainer;
  if (activeContainer && activeContainer !== "main-content") {
    console.log(`NavButtons: Ignoring click because ${activeContainer} is active`);
    return true;
  }
  
  // 🆕 LOGO EXCLUSION ZONE - but only when logo is VISIBLE
  const logoContainer = document.getElementById('logoContainer');
  if (logoContainer && !logoContainer.classList.contains('hidden-nav')) {
    // Logo is visible, so create exclusion zone
    const logoRect = logoContainer.getBoundingClientRect();
    const exclusionZone = {
      left: 0,
      top: 0,
      right: logoRect.right + 20, // Add 20px buffer
      bottom: logoRect.bottom + 20 // Add 20px buffer
    };
    
    const clickX = event.clientX;
    const clickY = event.clientY;
    
    if (clickX >= exclusionZone.left && 
        clickX <= exclusionZone.right && 
        clickY >= exclusionZone.top && 
        clickY <= exclusionZone.bottom) {
      console.log('NavButtons: Ignoring click in logo exclusion zone (logo visible)');
      return true;
    }
  }
  // If logo is hidden (has hidden-nav class), no exclusion zone - allow toggling
  
  // SPECIFIC BUTTON HANDLING
  if (event.target.closest('#logoContainer, #userButton, #newBook, #editButton, #toc-toggle-button')) {
    console.log('NavButtons: Ignoring click on specific nav button - let it do its action');
    return true;
  }
  
  // Rest of your existing code...
  if (event.target.matches('button, a, input, select, textarea, [role="button"]')) {
    console.log('NavButtons: Ignoring click on interactive element:', event.target.tagName);
    return true;
  }
  
  if (event.target.closest('.hidden, .overlay, #toc-container, #highlight-container, #ref-container')) {
    console.log('NavButtons: Ignoring click inside modal container');
    return true;
  }
  
  return (
    event.target.closest("sup.note") ||
    event.target.closest("mark") ||
    event.target.closest(".open") ||
    event.target.closest(".active")
  );
}

  /**
   * Record the starting pointer/touch coordinates.
   */
  handlePointerDown(event) {
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    this.startX = event.clientX;
    this.startY = event.clientY;
  }

  /**
   * On pointer/touch up, check if the movement is small enough to be considered a tap.
   */
    /**
   * On pointer/touch up, check if the movement is small enough to be considered a tap.
   */
  handlePointerUp(event) {
    const mainContent = document.querySelector(".main-content");
    if (!mainContent || mainContent.offsetParent === null) {
      return;
    }
    
    // 🆕 ADD DEBUGGING FOR TOUCH
    console.log('Touch event target:', event.target);
    console.log('Touch event target closest button:', event.target.closest('button'));
    console.log('Touch event target closest logoContainer:', event.target.closest('#logoContainer'));
    
    if (this.shouldIgnoreEvent(event)) {
      console.log('Touch event ignored by shouldIgnoreEvent');
      return;
    }
    
    const deltaX = Math.abs(event.clientX - this.startX);
    const deltaY = Math.abs(event.clientY - this.startY);
    
    console.log(`Touch delta: X=${deltaX}, Y=${deltaY}, threshold=${this.tapThreshold}`);
    
    if (deltaX < this.tapThreshold && deltaY < this.tapThreshold) {
      console.log('NavButtons: Toggling navigation (touch)');
      this.elements.forEach((element) => {
        element.classList.toggle("hidden-nav");
        console.log(`- Toggled ${element.id}, hidden-nav: ${element.classList.contains("hidden-nav")}`);
      });
    } else {
      console.log('Touch movement too large, not toggling');
    }
  }

  /**
   * On click (desktop), toggle the navigation container.
   */
  handleClick(event) {
    const mainContent = document.querySelector(".main-content");
    if (!mainContent || mainContent.offsetParent === null) {
      return;
    }
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    console.log('NavButtons: Toggling navigation (click)');
    this.elements.forEach((element) => {
      element.classList.toggle("hidden-nav");
      console.log(`- Toggled ${element.id}, hidden-nav: ${element.classList.contains("hidden-nav")}`);
    });
  }

  /**
   * Update the position of nav-buttons relative to the .main-content and viewport.
   */
  updatePosition() {
  window.requestAnimationFrame(() => {
    console.log('updatePosition called, isInitialized:', this.isInitialized);
    
    const mainContent = document.querySelector(".main-content");
    if (!mainContent) {
      console.log('No main-content found, returning');
      return;
    }
    
    const windowWidth = window.innerWidth;
    const computedMainWidth = mainContent.offsetWidth - 20;
    const margin = (windowWidth - computedMainWidth) / 2;

    const minDistance = 20;
    let newRight, newLeft;
    if (margin >= 2 * minDistance) {
      newRight = margin - minDistance;
      newLeft = margin - minDistance;
    } else {
      newRight = margin / 2;
      newLeft = margin / 2;
    }

    console.log(`Positioning: windowWidth=${windowWidth}, mainWidth=${computedMainWidth}, margin=${margin}, newRight=${newRight}, newLeft=${newLeft}`);

    // Position all loading elements
      this.loadingElements.forEach((element) => {
        if (element.id === "nav-buttons" || element.id === "topRightContainer") {
          element.style.right = `${newRight}px`;
          console.log(`Set ${element.id} right to ${newRight}px`);
        } else if (element.id === "logoContainer" || element.id === "userButtonContainer") {
          element.style.left = `${newLeft}px`;
          console.log(`Set ${element.id} left to ${newLeft}px`);
        }
      });

      // Remove loading class after positioning with a delay
      if (!this.isInitialized) {
        console.log('Removing loading class after positioning');
        
        // Add a longer delay to ensure positioning is complete
        setTimeout(() => {
          this.loadingElements.forEach((element) => {
            element.classList.remove("loading");
            console.log(`Removed loading class from: ${element.id}`);
          });
        }, 250); // Increased delay
        
        this.isInitialized = true;
        console.log('isInitialized set to true');
      }
    });
  }

  /**
   * Handle resize event:
   * - Temporarily disable the right transition.
   * - Update the position.
   * - Remove the temporary class after the resize stops.
   */
  handleResize() {
    console.log('NavButtons resize event');
    this.loadingElements.forEach((element) => {
      element.classList.add("disable-right-transition");
    });
    this.updatePosition();
    clearTimeout(this.resizeDebounceTimeout);
    this.resizeDebounceTimeout = setTimeout(() => {
      this.loadingElements.forEach((element) => {
        element.classList.remove("disable-right-transition");
      });
      console.log('Resize transition re-enabled');
    }, 100);
  }
}