// This is your working code, with the "bad guess" removed and the scroll call made reliable.

import { getKeyboardWasRecentlyClosed, setKeyboardWasRecentlyClosed } from './utilities/operationState.js';

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    this.state = {
      focusedElement: null,
      keyboardTop: null,
    };
    this.lastOffsetTop = 0; // Track offsetTop changes for refocus detection
    this.cachedSearchToolbarHeight = null; // Cache search toolbar height to avoid iOS scroll bug
    this.cachedSearchOffsetTop = null; // Cache offsetTop for search-input rapid reopen

    // Debouncing property
    this.viewportChangeDebounceTimer = null;
    this.keyboardClosedFlagTimer = null; // Auto-clear keyboardWasRecentlyClosed flag

    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.preventToolbarScroll = this.preventToolbarScroll.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.handleFocusOut = this.handleFocusOut.bind(this);
    this.init();

    window.addEventListener("focusin", this.handleFocusIn, true);
    window.addEventListener("focusout", this.handleFocusOut, true);
  }

  init() {
    if (!window.visualViewport) {
      console.warn("Visual Viewport API not supported");
      return;
    }
    this.initialVisualHeight = window.visualViewport.height;
    window.visualViewport.addEventListener(
      "resize",
      this.handleViewportChange,
    );
  }

  // SIMPLIFIED: This now only tracks the focused element. No more guessing.
  handleFocusIn(e) {
    if (
      !e.target.isContentEditable &&
      !["INPUT", "TEXTAREA"].includes(e.target.tagName)
    ) {
      return;
    }
    this.state.focusedElement = e.target;

    // QUICK REOPEN FIX: If keyboard was recently closed, force layout on focusin
    // This catches cases where iOS doesn't fire viewport resize events on rapid reopen
    if (getKeyboardWasRecentlyClosed()) {
      console.log('⚡ Quick reopen detected in focusin - scheduling forced layout');

      // Wait briefly for iOS to start keyboard animation
      setTimeout(() => {
        if (!this.isKeyboardOpen && this.state.focusedElement) {
          const vv = window.visualViewport;

          // SEARCH-INPUT SPECIAL CASE: If offsetTop is still 0 due to iOS scroll lag
          if (vv.offsetTop === 0 && this.isIOS && this.state.focusedElement.id === 'search-input') {
            // Check if we have a cached offsetTop from previous successful open
            if (this.cachedSearchOffsetTop) {
              console.log(`⚡ Quick reopen on search-input with offsetTop=0 - using cached offsetTop=${this.cachedSearchOffsetTop}px`);
              this.isKeyboardOpen = true;
              this.lastOffsetTop = this.cachedSearchOffsetTop;
              this.adjustLayout(true, this.cachedSearchOffsetTop);
              setKeyboardWasRecentlyClosed(false);
              if (this.keyboardClosedFlagTimer) {
                clearTimeout(this.keyboardClosedFlagTimer);
                this.keyboardClosedFlagTimer = null;
              }
              return;
            } else {
              console.log('⏸️ Quick reopen on search-input but offsetTop=0 and no cache - letting viewport handler take over');
              this.isKeyboardOpen = true;
              this.lastOffsetTop = 0;
              // Don't clear the flag - let the viewport handler catch it when offsetTop updates
              return;
            }
          }

          console.log('⚡ Forcing keyboard open state and layout adjustment');
          this.isKeyboardOpen = true;
          this.lastOffsetTop = vv.offsetTop;
          this.adjustLayout(true);
          setKeyboardWasRecentlyClosed(false);

          // Clear the auto-clear timer since we handled the flag
          if (this.keyboardClosedFlagTimer) {
            clearTimeout(this.keyboardClosedFlagTimer);
            this.keyboardClosedFlagTimer = null;
          }

          // Schedule scroll for contenteditable (skip for search-input)
          if (this.state.focusedElement.id !== 'search-input') {
            setTimeout(() => {
              if (this.state.focusedElement) {
                this.scrollCaretIntoView(this.state.focusedElement);
              }
            }, 250);
          }
        }
      }, 150);
    }
  }

  handleFocusOut() {
    if (this.isKeyboardOpen) {
      this.isKeyboardOpen = false;
      setKeyboardWasRecentlyClosed(true);

      // Auto-clear flag after 1 second as safeguard
      if (this.keyboardClosedFlagTimer) {
        clearTimeout(this.keyboardClosedFlagTimer);
      }
      this.keyboardClosedFlagTimer = setTimeout(() => {
        setKeyboardWasRecentlyClosed(false);
        console.log('⏱️ Auto-cleared keyboardWasRecentlyClosed flag after timeout');
      }, 1000);

      this.adjustLayout(false);
    }
    this.state.focusedElement = null;
  }

  preventToolbarScroll(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

// Debounced handler for viewport changes
handleViewportChange() {
  // Clear any pending debounce
  if (this.viewportChangeDebounceTimer) {
    clearTimeout(this.viewportChangeDebounceTimer);
  }

  // Debounce: wait 150ms after last viewport change before processing
  this.viewportChangeDebounceTimer = setTimeout(() => {
    this.processViewportChange();
  }, 150);
}

// Process viewport changes
processViewportChange() {
  const vv = window.visualViewport;
  const referenceHeight = this.isIOS
    ? this.initialVisualHeight
    : window.innerHeight;
  const keyboardOpen = vv.height < referenceHeight * 0.9;

  console.log(`📐 Viewport: height=${vv.height}px, offsetTop=${vv.offsetTop}px, keyboardOpen=${keyboardOpen}, isKeyboardOpen=${this.isKeyboardOpen}`);

  // REFOCUS FIX: Detect when offsetTop changes significantly while keyboard is already open
  // This happens on search-toolbar refocus when iOS fires viewport events twice
  const offsetTopChanged = Math.abs(vv.offsetTop - this.lastOffsetTop) > 50;
  if (keyboardOpen && this.isKeyboardOpen && offsetTopChanged) {
    console.log(`📍 Keyboard already open but offsetTop changed from ${this.lastOffsetTop}px to ${vv.offsetTop}px`);

    // For search-input, skip repositioning to avoid content shift during iOS scroll
    // Just update lastOffsetTop so future events work correctly
    if (this.state.focusedElement?.id === 'search-input') {
      console.log('⏸️ Search input refocus - updating lastOffsetTop only, skipping adjustLayout');
      this.lastOffsetTop = vv.offsetTop;
      // Cache offsetTop for rapid reopen
      if (vv.offsetTop > 0) {
        this.cachedSearchOffsetTop = vv.offsetTop;
        console.log(`💾 Cached search offsetTop: ${vv.offsetTop}px`);
      }
      return;
    }

    // Normal refocus for contenteditable - reposition toolbar
    console.log('📍 Repositioning toolbar for contenteditable refocus');
    this.lastOffsetTop = vv.offsetTop;
    this.adjustLayout(true);

    // Normal scroll logic for contenteditable on refocus
    const keyboardTop = vv.offsetTop + vv.height;
    console.log(`📍 Keyboard top position: ${keyboardTop}px (vv.offsetTop=${vv.offsetTop}, vv.height=${vv.height})`);

    setTimeout(() => {
      if (this.state.focusedElement) {
        this.scrollCaretIntoView(this.state.focusedElement);
      }
    }, 350);

    return;
  }

  // QUICK REOPEN FIX: If keyboard was recently closed and we detect it's open now, force repositioning
  if (keyboardOpen && getKeyboardWasRecentlyClosed()) {
    console.log('⚡ Quick reopen detected - forcing layout adjustment');
    this.isKeyboardOpen = true;
    this.lastOffsetTop = vv.offsetTop;
    this.adjustLayout(true);
    setKeyboardWasRecentlyClosed(false);

    // Clear the auto-clear timer since we handled the flag
    if (this.keyboardClosedFlagTimer) {
      clearTimeout(this.keyboardClosedFlagTimer);
      this.keyboardClosedFlagTimer = null;
    }

    // Schedule scroll for contenteditable (skip for search-input)
    if (this.state.focusedElement && this.state.focusedElement.id !== 'search-input') {
      setTimeout(() => {
        if (this.state.focusedElement) {
          this.scrollCaretIntoView(this.state.focusedElement);
        }
      }, 350);
    }
    return;
  }

  if (keyboardOpen !== this.isKeyboardOpen) {
    // Keyboard opening detected
    if (keyboardOpen && !this.isKeyboardOpen) {
      console.log('⌨️ Keyboard opening...');

      // REFOCUS FIX: Skip positioning ONLY for search-input when offsetTop is still 0
      // Search input refocus has iOS scroll lag, contenteditable doesn't
      // The offsetTop change handler will position correctly when offsetTop updates
      if (vv.offsetTop === 0 && this.isIOS &&
          this.state.focusedElement?.id === 'search-input') {
        console.log('⏸️ Search input focused but offsetTop=0 - waiting for scroll to complete...');
        this.isKeyboardOpen = true;
        this.lastOffsetTop = 0;
        return; // Don't call adjustLayout yet
      }
    }

    // Keyboard closing detected
    if (!keyboardOpen && this.isKeyboardOpen) {
      console.log('⌨️ Keyboard closed');
      setKeyboardWasRecentlyClosed(true);

      // Auto-clear flag after 1 second as safeguard
      if (this.keyboardClosedFlagTimer) {
        clearTimeout(this.keyboardClosedFlagTimer);
      }
      this.keyboardClosedFlagTimer = setTimeout(() => {
        setKeyboardWasRecentlyClosed(false);
        console.log('⏱️ Auto-cleared keyboardWasRecentlyClosed flag after timeout');
      }, 1000);
    }

    this.isKeyboardOpen = keyboardOpen;

    // Track offsetTop on state changes (but reset to 0 on close for clean state)
    this.lastOffsetTop = keyboardOpen ? vv.offsetTop : 0;

    this.adjustLayout(keyboardOpen);

    // If the keyboard just opened AND we have a focused element...
    if (keyboardOpen && this.state.focusedElement) {
      // SKIP scroll logic for search-input - it doesn't need page scrolling
      // Search input just needs toolbar positioned above keyboard
      if (this.state.focusedElement.id === 'search-input') {
        console.log('⏭️ Skipping scroll for search-input (no caret scrolling needed)');
        // Cache offsetTop for rapid reopen
        if (vv.offsetTop > 0) {
          this.cachedSearchOffsetTop = vv.offsetTop;
          console.log(`💾 Cached search offsetTop: ${vv.offsetTop}px`);
        }
        return;
      }

      // Normal scroll logic for contenteditable elements
      const keyboardTop = vv.offsetTop + vv.height;
      console.log(`📍 Keyboard top position: ${keyboardTop}px (vv.offsetTop=${vv.offsetTop}, vv.height=${vv.height})`);

      // Fixed delay - iOS doesn't fire resize events during animation
      const scrollDelay = 350;
      console.log(`⌨️ Scheduling scroll with ${scrollDelay}ms delay`);

      setTimeout(() => {
        if (this.state.focusedElement) {
          this.scrollCaretIntoView(this.state.focusedElement);
        }
      }, scrollDelay);
    }
  }
}

// Renamed and cleaned up for production
scrollCaretIntoView(element) {
  // Get the actual cursor/caret position
  const selection = window.getSelection();
  let caretRect = null;
  
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    caretRect = range.getBoundingClientRect();
  }
  
  if (!caretRect || (caretRect.width === 0 && caretRect.height === 0)) {
    return; // Silently fail if no caret
  }
  
  const toolbar = document.querySelector("#edit-toolbar");
  const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
  const vv = window.visualViewport;
  
  if (toolbarRect) {
    const viewportTop = vv.offsetTop;
    const toolbarTop = toolbarRect.top;
    const buffer = 20; // Add some breathing room
    
    // Check if caret is visible (between viewport top and toolbar with buffer)
    const isCaretVisible = caretRect.top >= viewportTop && 
                          caretRect.bottom <= (toolbarTop - buffer);
    
    if (!isCaretVisible) {
      // Use scrollBy for more precise control
      const scrollContainer = document.querySelector(".reader-content-wrapper");
      if (scrollContainer) {
        const scrollAmount = caretRect.bottom - (toolbarTop - buffer);
        scrollContainer.scrollBy({
          top: scrollAmount,
          behavior: "smooth"
        });
      }
    }
  }
}

  // All the functions below are from YOUR working version. They are unchanged.
  adjustLayout(keyboardOpen, overrideOffsetTop = null) {
    console.log(`🔧 KeyboardManager.adjustLayout called with keyboardOpen=${keyboardOpen}, overrideOffsetTop=${overrideOffsetTop}`);

    const appContainer = document.querySelector("#app-container");
    const mainContent = document.querySelector(".main-content");
    const editToolbar = document.querySelector("#edit-toolbar");
    const searchToolbar = document.querySelector("#search-toolbar");
    const bottomRightButtons = document.querySelector("#bottom-right-buttons");
    const hyperlitContainer = document.querySelector("#hyperlit-container");

    if (keyboardOpen) {
      console.log("🔧 KeyboardManager: KEYBOARD OPENING - will modify layout");
      const vv = window.visualViewport;
      const effectiveOffsetTop = overrideOffsetTop !== null ? overrideOffsetTop : vv.offsetTop;

      console.log(`🔍 DEBUG adjustLayout: vv.offsetTop=${vv.offsetTop}, effectiveOffsetTop=${effectiveOffsetTop}, vv.height=${vv.height}`);

      if (appContainer) {
        appContainer.style.setProperty("position", "fixed", "important");
        appContainer.style.setProperty("top", `${effectiveOffsetTop}px`, "important");
        appContainer.style.setProperty("height", `${vv.height}px`, "important");
        appContainer.style.setProperty("width", "100%", "important");
        appContainer.style.setProperty("left", "0", "important");
        appContainer.style.setProperty("z-index", "1", "important");
      }

      const keyboardHeight = window.innerHeight - vv.height;
      this.createOrUpdateSpacer(keyboardHeight);

      const newKeyboardTop = effectiveOffsetTop + vv.height;
      console.log(`🔍 DEBUG: Setting keyboardTop from ${this.state.keyboardTop} to ${newKeyboardTop}`);
      this.state.keyboardTop = newKeyboardTop;
      this.moveToolbarAboveKeyboard(editToolbar, searchToolbar, bottomRightButtons, mainContent);

      // Also adjust hyperlit-container if it's open
      if (hyperlitContainer && hyperlitContainer.classList.contains('open')) {
        this.adjustHyperlitContainerHeight(hyperlitContainer, vv);
      }
    } else {
      console.log("🔧 KeyboardManager: KEYBOARD CLOSING - will reset inline styles");
      if (editToolbar) {
        editToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      if (searchToolbar) {
        searchToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      if (bottomRightButtons) {
        bottomRightButtons.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      this.removeSpacer();
      this.resetInlineStyles(appContainer, mainContent, editToolbar, searchToolbar, bottomRightButtons);

      // Reset hyperlit-container height if it's open
      if (hyperlitContainer && hyperlitContainer.classList.contains('open')) {
        this.adjustHyperlitContainerHeight(hyperlitContainer, window.visualViewport);
      }

      console.log("🔧 KeyboardManager: Inline styles reset on all elements including #bottom-right-buttons");
      this.state.keyboardTop = null;
    }
  }

  moveToolbarAboveKeyboard(editToolbar, searchToolbar, bottomRightButtons, mainContent) {
    console.log("🔧 KeyboardManager.moveToolbarAboveKeyboard called");

    // Determine which toolbar is visible
    const visibleToolbar =
      (searchToolbar && searchToolbar.classList.contains('visible')) ? searchToolbar :
      (editToolbar && editToolbar.classList.contains('visible')) ? editToolbar :
      null;

    if (!visibleToolbar) return;

    // SEARCH TOOLBAR ONLY: Cache height to avoid iOS getBoundingClientRect bug during scroll
    // Edit toolbar uses getBoundingClientRect() normally (unchanged)
    let toolbarHeight;
    if (visibleToolbar.id === 'search-toolbar') {
      if (!this.cachedSearchToolbarHeight) {
        this.cachedSearchToolbarHeight = visibleToolbar.getBoundingClientRect().height;
        console.log(`🔍 Cached search toolbar height: ${this.cachedSearchToolbarHeight}px`);
      }
      toolbarHeight = this.cachedSearchToolbarHeight;
    } else {
      // Edit toolbar: use getBoundingClientRect() as normal
      toolbarHeight = visibleToolbar.getBoundingClientRect().height;
    }

    console.log(`🔍 DEBUG moveToolbar: this.state.keyboardTop=${this.state.keyboardTop}, toolbarHeight=${toolbarHeight}`);
    const top = this.state.keyboardTop - toolbarHeight;
    console.log(`🔍 DEBUG moveToolbar: Calculated top=${top}`);

    visibleToolbar.style.setProperty("position", "fixed", "important");
    visibleToolbar.style.setProperty("top", `${top}px`, "important");
    visibleToolbar.style.setProperty("left", "0", "important");
    visibleToolbar.style.setProperty("right", "0", "important");
    visibleToolbar.style.setProperty("z-index", "999999", "important");

    // Remove old listener before adding to prevent buildup
    visibleToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
    visibleToolbar.addEventListener("touchstart", this.preventToolbarScroll, {
      passive: false,
    });

    if (mainContent) {
      const paddingBottom = toolbarHeight + 80;
      mainContent.style.setProperty(
        "padding-bottom",
        `${paddingBottom}px`,
        "important",
      );
    }

    if (bottomRightButtons) {
      // Only reposition bottom-right-buttons for edit-toolbar
      // Search-toolbar is centered and doesn't interfere with right-side buttons
      if (visibleToolbar.id === 'edit-toolbar') {
        // Check if hyperlit-container is open - if so, use lower z-index to stay below overlay/container
        const hyperlitContainerOpen = document.body.classList.contains('hyperlit-container-open');
        const zIndex = hyperlitContainerOpen ? "998" : "999998";

        console.log(`🔧 KeyboardManager: SETTING INLINE STYLES ON #bottom-right-buttons - z-index: ${zIndex}, top: ${top - 60}px (hyperlitContainer open: ${hyperlitContainerOpen})`);
        bottomRightButtons.style.setProperty("position", "fixed", "important");
        bottomRightButtons.style.setProperty("top", `${top - 60}px`, "important");
        bottomRightButtons.style.setProperty("right", "5px", "important");
        bottomRightButtons.style.setProperty("z-index", zIndex, "important");
        bottomRightButtons.addEventListener("touchstart", this.preventToolbarScroll, {
          passive: false,
        });
      }
    }
  }

  adjustHyperlitContainerHeight(container, vv) {
    if (!vv) {
      // Fallback if Visual Viewport API not available
      const maxHeight = window.innerHeight - 16 - 4; // topMargin - bottomGap
      container.style.maxHeight = `${maxHeight}px`;
      console.log(`🔧 KeyboardManager: Set hyperlit-container maxHeight to ${maxHeight}px (no VV API)`);
      return;
    }

    const topMargin = 16; // 1em top spacing (matches CSS top: 1em)
    const BOTTOM_GAP = 4; // Visual gap between container and keyboard/screen bottom
    const maxHeight = vv.offsetTop + vv.height - topMargin - BOTTOM_GAP;

    console.log(`🔧 KeyboardManager: Set hyperlit-container maxHeight to ${maxHeight}px (vv.height: ${vv.height}px, offsetTop: ${vv.offsetTop}px)`);
    container.style.maxHeight = `${maxHeight}px`;
  }
   

  resetInlineStyles(...elements) {
    const props = [
      "position",
      "top",
      "left",
      "height",
      "width",
      "z-index",
      "padding-bottom",
      "touch-action",
    ];
    elements.forEach((el) => {
      if (!el) return;
      props.forEach((p) => el.style.removeProperty(p));
    });
  }
createOrUpdateSpacer(height) {
  const spacer = document.querySelector("#keyboard-spacer");
  if (spacer) {
    // Use the larger of keyboard height or minimum reading height
    const minHeight = 100;
    spacer.style.height = `${Math.max(height, minHeight)}px`;
  }
}

removeSpacer() {
  const spacer = document.querySelector("#keyboard-spacer");
  if (spacer) {
    // Reset to minimum height instead of removing
    spacer.style.height = "100px";
  }
}

  destroy() {
    // Clear any pending timers
    if (this.viewportChangeDebounceTimer) {
      clearTimeout(this.viewportChangeDebounceTimer);
      this.viewportChangeDebounceTimer = null;
    }
    if (this.keyboardClosedFlagTimer) {
      clearTimeout(this.keyboardClosedFlagTimer);
      this.keyboardClosedFlagTimer = null;
    }

    // Reset inline styles on all elements we modified
    this.resetInlineStyles(
      document.querySelector("#app-container"),
      document.querySelector(".main-content"),
      document.querySelector("#edit-toolbar"),
      document.querySelector("#search-toolbar"),
      document.querySelector("#bottom-right-buttons")
    );

    window.removeEventListener("focusin", this.handleFocusIn, true);
    window.removeEventListener("focusout", this.handleFocusOut, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.handleViewportChange,
      );
    }
  }
}

export { KeyboardManager };