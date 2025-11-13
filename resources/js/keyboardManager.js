// This is your working code, with the "bad guess" removed and the scroll call made reliable.

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    this.state = {
      focusedElement: null,
      keyboardTop: null,
    };

    // Debouncing property
    this.viewportChangeDebounceTimer = null;

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
  }

  handleFocusOut() {
    if (this.isKeyboardOpen) {
      this.isKeyboardOpen = false;
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

  if (keyboardOpen !== this.isKeyboardOpen) {
    // Keyboard opening detected
    if (keyboardOpen && !this.isKeyboardOpen) {
      console.log('⌨️ Keyboard opening...');
    }

    // Keyboard closing detected
    if (!keyboardOpen && this.isKeyboardOpen) {
      console.log('⌨️ Keyboard closed');
    }

    this.isKeyboardOpen = keyboardOpen;
    this.adjustLayout(keyboardOpen);

    // If the keyboard just opened AND we have a focused element...
    if (keyboardOpen && this.state.focusedElement) {
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
  adjustLayout(keyboardOpen) {
    console.log(`🔧 KeyboardManager.adjustLayout called with keyboardOpen=${keyboardOpen}`);

    const appContainer = document.querySelector("#app-container");
    const mainContent = document.querySelector(".main-content");
    const editToolbar = document.querySelector("#edit-toolbar");
    const bottomRightButtons = document.querySelector("#bottom-right-buttons");
    const hyperlitContainer = document.querySelector("#hyperlit-container");

    if (keyboardOpen) {
      console.log("🔧 KeyboardManager: KEYBOARD OPENING - will modify layout");
      const vv = window.visualViewport;

      if (appContainer) {
        appContainer.style.setProperty("position", "fixed", "important");
        appContainer.style.setProperty("top", `${vv.offsetTop}px`, "important");
        appContainer.style.setProperty("height", `${vv.height}px`, "important");
        appContainer.style.setProperty("width", "100%", "important");
        appContainer.style.setProperty("left", "0", "important");
        appContainer.style.setProperty("z-index", "1", "important");
      }

      const keyboardHeight = window.innerHeight - vv.height;
      this.createOrUpdateSpacer(keyboardHeight);

      this.state.keyboardTop = vv.offsetTop + vv.height;
      this.moveToolbarAboveKeyboard(editToolbar, bottomRightButtons, mainContent);

      // Also adjust hyperlit-container if it's open
      if (hyperlitContainer && hyperlitContainer.classList.contains('open')) {
        this.adjustHyperlitContainerHeight(hyperlitContainer, vv);
      }
    } else {
      console.log("🔧 KeyboardManager: KEYBOARD CLOSING - will reset inline styles");
      if (editToolbar) {
        editToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      if (bottomRightButtons) {
        bottomRightButtons.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      this.removeSpacer();
      this.resetInlineStyles(appContainer, mainContent, editToolbar, bottomRightButtons);

      // Reset hyperlit-container height if it's open
      if (hyperlitContainer && hyperlitContainer.classList.contains('open')) {
        this.adjustHyperlitContainerHeight(hyperlitContainer, window.visualViewport);
      }

      console.log("🔧 KeyboardManager: Inline styles reset on all elements including #bottom-right-buttons");
      this.state.keyboardTop = null;
    }
  }

  moveToolbarAboveKeyboard(toolbar, bottomRightButtons, mainContent) {
    console.log("🔧 KeyboardManager.moveToolbarAboveKeyboard called");
    if (!toolbar) return;
    const toolbarHeight = toolbar.getBoundingClientRect().height;
    const top = this.state.keyboardTop - toolbarHeight;

    toolbar.style.setProperty("position", "fixed", "important");
    toolbar.style.setProperty("top", `${top}px`, "important");
    toolbar.style.setProperty("left", "0", "important");
    toolbar.style.setProperty("right", "0", "important");
    toolbar.style.setProperty("z-index", "999999", "important");

    // Remove old listener before adding to prevent buildup
    toolbar.removeEventListener("touchstart", this.preventToolbarScroll);
    toolbar.addEventListener("touchstart", this.preventToolbarScroll, {
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

    // Reset inline styles on all elements we modified
    this.resetInlineStyles(
      document.querySelector("#app-container"),
      document.querySelector(".main-content"),
      document.querySelector("#edit-toolbar"),
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