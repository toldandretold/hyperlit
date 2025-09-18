// Export the NavButtons class
export default class NavButtons {
  constructor(options = {}) {
    // 1. Store the configuration.
    this.elementIds = options.elementIds || ["nav-buttons"];
    this.tapThreshold = options.tapThreshold || 10;
    this.desktopBreakpoint = options.desktopBreakpoint || 768;

    // Define all possible elements this manager might control.
    this.possibleLoadingElementIds = [
      "nav-buttons", "topRightContainer", "logoContainer",
      "userButtonContainer", "edit-toolbar",
    ];

    // Initialize properties that will be set by rebindElements
    this.elements = [];
    this.loadingElements = [];
    
    this.startX = 0;
    this.startY = 0;
    this.isInitialized = false;
    this.isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;

    // Bind event handlers once
    this.handleClick = this.handleClick.bind(this);
    this.updatePosition = this.updatePosition.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleKeyboardChange = this.handleKeyboardChange.bind(this);
  }

  // =================================================================
  // THIS IS THE NEW METHOD. It's the "take a new photo" function.
  // =================================================================
  rebindElements() {
    console.log("Rebinding elements for NavButtons...");
    
    // Find the elements that exist on the CURRENT page.
    this.elements = this.elementIds
      .map((id) => document.getElementById(id))
      .filter((el) => el !== null);

    this.loadingElements = this.possibleLoadingElementIds
      .map((id) => document.getElementById(id))
      .filter((el) => el !== null);

    console.log("Rebound complete. Found elements to toggle:", this.elements.length);
  }

  init() {
    if (this.isInitialized) return; // Prevent adding listeners multiple times

    // Find the initial set of elements on the current page.
    this.rebindElements();

    if (this.isTouchDevice) {
      document.addEventListener("touchstart", this.handleTouchStart.bind(this), { passive: false });
      document.addEventListener("touchend", this.handleTouchEnd.bind(this), { passive: false });
    } else {
      document.addEventListener("click", this.handleClick);
    }
    this.updatePosition();
    window.addEventListener("resize", this.handleResize);
    window.addEventListener('keyboardStateChange', this.handleKeyboardChange);
    
    this.isInitialized = true;
  }
  

  /**
   * Remove event listeners.
   */
  destroy() {
    if (!this.isInitialized) return;
    
    console.log("🧹 NavButtons: Destroying and removing event listeners");
    
    // Remove all event listeners
    document.removeEventListener("click", this.handleClick);
    window.removeEventListener("resize", this.updatePosition);
    window.removeEventListener("keyboardDidShow", this.handleKeyboardChange);
    window.removeEventListener("keyboardDidHide", this.handleKeyboardChange);
    
    // Clear element references
    this.elements = [];
    this.loadingElements = [];
    
    this.isInitialized = false;
    console.log("✅ NavButtons: Destroyed successfully");
  }



  handleKeyboardChange(event) {
    this.isKeyboardVisible = event.detail.isOpen;
    console.log('Keyboard state changed:', this.isKeyboardVisible);
  }

  /**
   * Checks if an event should be ignored.
   */
shouldIgnoreEvent(event) {
  // Always ignore edit toolbar - let it handle its own events without toggling nav
  if (event.target.closest('#edit-toolbar')) {
    console.log('NavButtons: Ignoring edit toolbar event - target:', event.target, 'type:', event.type);
    return true;
  }
  
  // Ignore other UI elements
  if (
    event.target.closest(
      "#logoContainer, #userButton, #newBook, #editButton, #toc-toggle-button, #cloudRef, .custom-alert, .custom-alert-overlay",
    )
  ) {
    return true;
  }
  
  // Don't toggle nav buttons when in edit mode
  if (window.isEditing) {
    return true;
  }
  
  // Ignore interactive elements
  if (
    event.target.closest("a") ||
    event.target.closest("sup.open-icon") ||
    event.target.closest("u.couple") ||
    event.target.closest("u.poly") ||
    event.target.closest("sup[fn-count-id]") ||  // Ignore footnote sup elements
    event.target.closest("a.footnote-ref") ||    // Ignore footnote links
    event.target.closest("a.in-text-citation")   // Ignore citation links
  ) {
    return true;
  }
  
  if (
    event.target.matches(
      'button, a, input, select, textarea, [role="button"]',
    )
  ) {
    return true;
  }
  
  return (
    event.target.closest("sup.note") ||
    event.target.closest("mark") ||
    event.target.closest(".open") ||
    event.target.closest(".active")
  );
}

  

    handleTouchStart(event) {
    // Early exit for edit toolbar to avoid any interference
    if (event.target.closest('#edit-toolbar')) {
      console.log('NavButtons: Edit toolbar touchstart - EARLY EXIT - target:', event.target);
      return;
    }
    
    if (this.shouldIgnoreEvent(event)) {
      console.log('NavButtons: Touch start ignored');
      return;
    }
    this.startX = event.touches[0].clientX;
    this.startY = event.touches[0].clientY;
    this.touchStartTime = Date.now();
  }

  handleTouchEnd(event) {
    // Early exit for edit toolbar to avoid any interference
    if (event.target.closest('#edit-toolbar')) {
      console.log('NavButtons: Edit toolbar touchend - EARLY EXIT - target:', event.target);
      return;
    }
    
    if (this.shouldIgnoreEvent(event)) {
      console.log('NavButtons: Touch end ignored');
      return;
    }
    
    // Only proceed if we have stored start coordinates
    if (this.startX === undefined || this.startY === undefined) return;
    
    const touch = event.changedTouches[0];
    const deltaX = Math.abs(touch.clientX - this.startX);
    const deltaY = Math.abs(touch.clientY - this.startY);
    const deltaTime = Date.now() - this.touchStartTime;
    
    // Only toggle if it's a quick tap with minimal movement
    if (deltaX < this.tapThreshold && deltaY < this.tapThreshold && deltaTime < 500) {
      this.elements.forEach((element) => {
        element.classList.toggle("hidden-nav");
      });
    }
    
    // Reset
    this.startX = undefined;
    this.startY = undefined;
    this.touchStartTime = undefined;
  }

  /**
   * On click (desktop), toggle the navigation container.
   */
  handleClick(event) {
    if (this.shouldIgnoreEvent(event)) return;
    this.elements.forEach((element) => {
      element.classList.toggle("hidden-nav");
    });
  }

  /**
   * Update the position of nav-buttons relative to the .main-content and viewport.
   */
  updatePosition() {
    // On mobile, let CSS handle everything. Remove any inline styles.
    if (window.innerWidth < this.desktopBreakpoint) {
      this.loadingElements.forEach((element) => {
        element.style.removeProperty("left");
        element.style.removeProperty("right");
      });
    } else {
      // On desktop, run the original intelligent positioning logic.
      window.requestAnimationFrame(() => {
        const mainContent =
          document.querySelector(".main-content") ||
          document.querySelector(".home-content-wrapper");
        if (!mainContent) return;

        const rect = mainContent.getBoundingClientRect();
        const marginSize = rect.left;
        const buttonGap = 20;
        const buttonWidth = 40;

        const newPos = marginSize - buttonGap - buttonWidth;

        this.loadingElements.forEach((element) => {
          // --- CHANGE 2: Add 'edit-toolbar' to this condition ---
          if (
            element.id === "nav-buttons" ||
            element.id === "topRightContainer" ||
            element.id === "edit-toolbar" // ADD THIS CONDITION
          ) {
            element.style.right = `${Math.max(10, newPos)}px`;
          } else if (
            element.id === "logoContainer" ||
            element.id === "userButtonContainer"
          ) {
            element.style.left = `${Math.max(10, newPos)}px`;
          }
        });
      });
    }

    // This part runs regardless of device to prevent Flash of Unstyled Content
    if (!this.isInitialized) {
      setTimeout(() => {
        this.loadingElements.forEach((element) => {
          element.classList.remove("loading");
        });
      }, 50);
      this.isInitialized = true;
    }
  }

  /**
   * Handle resize event.
   */
  handleResize() {
    this.updatePosition();
  }
}