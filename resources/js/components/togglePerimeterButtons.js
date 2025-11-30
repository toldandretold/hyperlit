import { cancelForcedVisibility, isProcessing } from './editIndicator.js';
import { log, verbose } from '../utilities/logger.js';
import { setPerimeterButtonsHidden } from '../utilities/operationState.js';

// Export the TogglePerimeterButtons class
export default class TogglePerimeterButtons {
  constructor(options = {}) {
    // 1. Store the configuration.
    this.elementIds = options.elementIds || [
      "bottom-right-buttons",
      "topRightContainer",
      "logoNavWrapper",
      "userButtonContainer"
    ];
    this.tapThreshold = options.tapThreshold || 10;
    this.desktopBreakpoint = options.desktopBreakpoint || 768;

    // Define all possible elements this manager might control.
    this.possibleLoadingElementIds = [
      "bottom-right-buttons", "topRightContainer", "logoNavWrapper",
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
    // Find the elements that exist on the CURRENT page.
    this.elements = this.elementIds
      .map((id) => document.getElementById(id))
      .filter((el) => el !== null);

    this.loadingElements = this.possibleLoadingElementIds
      .map((id) => document.getElementById(id))
      .filter((el) => el !== null);
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
    log.init('Perimeter button controls initialized', '/components/togglePerimeterButtons.js');
  }
  

  /**
   * Remove event listeners.
   */
  destroy() {
    if (!this.isInitialized) return;

    // Remove all event listeners
    document.removeEventListener("click", this.handleClick);
    window.removeEventListener("resize", this.updatePosition);
    window.removeEventListener("keyboardDidShow", this.handleKeyboardChange);
    window.removeEventListener("keyboardDidHide", this.handleKeyboardChange);

    // Clear element references
    this.elements = [];
    this.loadingElements = [];

    this.isInitialized = false;
  }



  handleKeyboardChange(event) {
    this.isKeyboardVisible = event.detail.isOpen;
    console.log('Keyboard state changed:', this.isKeyboardVisible);
  }

  /**
   * Checks if a click is near important buttons (logo, user, source, edit, TOC)
   * Returns true if the click is within an expanded area around these buttons
   */
  isClickNearImportantButton(event) {
    const logoNavWrapper = document.getElementById('logoNavWrapper');
    const userButton = document.getElementById('userButton');
    const userButtonContainer = document.getElementById('userButtonContainer');
    const cloudRef = document.getElementById('cloudRef');
    const editButton = document.getElementById('editButton');
    const tocToggleButton = document.getElementById('toc-toggle-button');

    // Get click coordinates
    const clickX = event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : 0);
    const clickY = event.clientY || (event.touches && event.touches[0] ? event.touches[0].clientY : 0);

    // Define expanded click area (padding around buttons)
    const padding = 20; // pixels of extra clickable area around buttons

    // Check logo nav wrapper
    if (logoNavWrapper) {
      const logoRect = logoNavWrapper.getBoundingClientRect();
      if (clickX >= logoRect.left - padding &&
          clickX <= logoRect.right + padding &&
          clickY >= logoRect.top - padding &&
          clickY <= logoRect.bottom + padding) {
        return true;
      }
    }
    
    // Check user button (try both the button itself and its container)
    const userElement = userButtonContainer || userButton;
    if (userElement) {
      const userRect = userElement.getBoundingClientRect();
      if (clickX >= userRect.left - padding && 
          clickX <= userRect.right + padding && 
          clickY >= userRect.top - padding && 
          clickY <= userRect.bottom + padding) {
        return true;
      }
    }
    
    // Check source button (cloudRef)
    if (cloudRef) {
      const cloudRect = cloudRef.getBoundingClientRect();
      if (clickX >= cloudRect.left - padding && 
          clickX <= cloudRect.right + padding && 
          clickY >= cloudRect.top - padding && 
          clickY <= cloudRect.bottom + padding) {
        return true;
      }
    }
    
    // Check edit button
    if (editButton) {
      const editRect = editButton.getBoundingClientRect();
      if (clickX >= editRect.left - padding && 
          clickX <= editRect.right + padding && 
          clickY >= editRect.top - padding && 
          clickY <= editRect.bottom + padding) {
        return true;
      }
    }
    
    // Check TOC toggle button
    if (tocToggleButton) {
      const tocRect = tocToggleButton.getBoundingClientRect();
      if (clickX >= tocRect.left - padding && 
          clickX <= tocRect.right + padding && 
          clickY >= tocRect.top - padding && 
          clickY <= tocRect.bottom + padding) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Checks if an event should be ignored.
   */
shouldIgnoreEvent(event) {
  // Always ignore edit toolbar - let it handle its own events without toggling nav
  if (event.target.closest('#edit-toolbar')) {
    console.log('TogglePerimeterButtons: Ignoring edit toolbar event - target:', event.target, 'type:', event.type);
    return true;
  }

  /*
  // Check if click is near important buttons (more forgiving click area)
  if (this.isClickNearImportantButton(event)) {
    console.log('TogglePerimeterButtons: Click near important button - ignoring to allow button interaction');
    return true;
  }
  */
  
  // Ignore other UI elements
  if (
    event.target.closest(
      "#logoNavWrapper, #logoContainer, #userButton, #newBook, #editButton, #toc-toggle-button, #cloudRef, .custom-alert, .custom-alert-overlay, #hyperlit-container, #ref-overlay",
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
      console.log('TogglePerimeterButtons: Edit toolbar touchstart - EARLY EXIT - target:', event.target);
      return;
    }

    if (this.shouldIgnoreEvent(event)) {
      console.log('TogglePerimeterButtons: Touch start ignored');
      return;
    }
    this.startX = event.touches[0].clientX;
    this.startY = event.touches[0].clientY;
    this.touchStartTime = Date.now();
  }

  handleTouchEnd(event) {
    // Early exit for edit toolbar to avoid any interference
    if (event.target.closest('#edit-toolbar')) {
      console.log('TogglePerimeterButtons: Edit toolbar touchend - EARLY EXIT - target:', event.target);
      return;
    }

    if (this.shouldIgnoreEvent(event)) {
      console.log('TogglePerimeterButtons: Touch end ignored');
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
      // Don't toggle nav visibility in edit mode
      if (window.isEditing) {
        console.log(`🔗 TogglePerimeterButtons: Ignoring touch toggle - edit mode is active`);
      } else {
        // Cancel any forced visibility from edit indicator
        cancelForcedVisibility();

        // Sync all buttons to same state instead of toggling individually
        // Pass false to apply full sync including topRightContainer (user deliberately toggled)
        this.syncPerimeterButtons(false);
      }
    }

    // Reset
    this.startX = undefined;
    this.startY = undefined;
    this.touchStartTime = undefined;
  }

  /**
   * Synchronize all perimeter buttons to either all visible or all hidden
   * based on current majority state
   * @param {boolean} respectEditIndicator - If true, exclude topRightContainer when isProcessing is active
   */
  syncPerimeterButtons(respectEditIndicator = false) {
    // Get the topRightContainer element
    const topRightContainer = document.getElementById('topRightContainer');

    // Determine which elements to consider for counting and syncing
    let elementsToSync = this.elements;

    // If we should respect the edit indicator and it's currently processing,
    // exclude topRightContainer from sync operations
    if (respectEditIndicator && isProcessing && topRightContainer) {
      elementsToSync = this.elements.filter(el => el !== topRightContainer);
      console.log('🔵 Excluding topRightContainer from sync - edit indicator is active');
    }

    // Count how many are currently visible (excluding topRightContainer if needed)
    const visibleCount = elementsToSync.filter(
      (el) => !el.classList.contains("perimeter-hidden")
    ).length;

    // If majority are visible, hide all. Otherwise, show all.
    const shouldHide = visibleCount > elementsToSync.length / 2;

    // Apply sync only to the filtered elements
    elementsToSync.forEach((element) => {
      if (shouldHide) {
        element.classList.add("perimeter-hidden");
      } else {
        element.classList.remove("perimeter-hidden");
      }
    });

    // Update central state (unless we excluded topRightContainer due to edit indicator)
    // Only update state based on the main perimeter buttons, not topRightContainer
    if (!respectEditIndicator || !isProcessing) {
      setPerimeterButtonsHidden(shouldHide);
    }
  }

  /**
   * On click (desktop), toggle the perimeter buttons.
   */
  handleClick(event) {
    if (this.shouldIgnoreEvent(event)) {
      return;
    }

    // Don't toggle perimeter button visibility in edit mode
    if (window.isEditing) {
      return;
    }

    // Cancel any forced visibility from edit indicator
    cancelForcedVisibility();

    // Sync all buttons to same state instead of toggling individually
    // Pass false to apply full sync including topRightContainer (user deliberately toggled)
    this.syncPerimeterButtons(false);
  }

  /**
   * Update the position of perimeter buttons relative to the .main-content and viewport.
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
          document.querySelector(".home-content-wrapper") ||
          document.querySelector(".user-content-wrapper");
        if (!mainContent) return;

        const rect = mainContent.getBoundingClientRect();
        const marginSize = rect.left;
        const buttonGap = 20;
        const buttonWidth = 40;

        const newPos = marginSize - buttonGap - buttonWidth;

        this.loadingElements.forEach((element) => {
          if (
            element.id === "bottom-right-buttons" ||
            element.id === "topRightContainer" ||
            element.id === "edit-toolbar"
          ) {
            element.style.right = `${Math.max(10, newPos)}px`;
          } else if (
            element.id === "logoNavWrapper" ||
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