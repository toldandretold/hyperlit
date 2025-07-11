// keyboardManager.js
import { setKeyboardLayoutInProgress } from "./operationState.js";

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    this.state = {
      originalMainContentPaddingBottom: null,
      keyboardTop: null,
      focusedElement: null,
      elementOffsetFromContentTop: null,
      focusedElementHeight: null,
      needsBottomFocusHandling: false,
    };

    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.preventToolbarScroll = this.preventToolbarScroll.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.init();

    window.addEventListener("focusin", this.handleFocusIn, true);

    window.addEventListener(
      "focusout",
      () => {
        // We only reset the layout if the keyboard is actually open.
        // This prevents issues with focus changing between non-input elements.
        if (this.isKeyboardOpen) {
          this.isKeyboardOpen = false;
          this.adjustLayout(false);
        }
        this.state.focusedElement = null;
      },
      true,
    );
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

    console.log("🔧 KeyboardManager: initialised", {
      isIOS: this.isIOS,
      initialHeight: this.initialVisualHeight,
    });
  }

  handleFocusIn(e) {
    // Only act on editable elements or inputs
    if (
      !e.target.isContentEditable &&
      !["INPUT", "TEXTAREA"].includes(e.target.tagName)
    ) {
      return;
    }

    const mainContent = document.querySelector(".main-content");
    if (!mainContent) return;

    this.state.focusedElement = e.target;

    if (!this.isKeyboardOpen) {
      const elementRect = e.target.getBoundingClientRect();
      const mainContentRect = mainContent.getBoundingClientRect();

      this.state.elementOffsetFromContentTop =
        elementRect.top - mainContentRect.top + mainContent.scrollTop;
      this.state.focusedElementHeight = elementRect.height;

      const elementBottomRelativeToContent =
        elementRect.bottom - mainContentRect.top;
      const contentVisibleHeight = mainContentRect.height;

      if (elementBottomRelativeToContent > contentVisibleHeight * 0.6) {
        this.state.needsBottomFocusHandling = true;
      }
    }
  }

  preventToolbarScroll(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  handleViewportChange() {
    const vv = window.visualViewport;
    // On iOS, the initial height is a more stable reference.
    const referenceHeight = this.isIOS
      ? this.initialVisualHeight
      : window.innerHeight;
    const keyboardOpen = vv.height < referenceHeight * 0.9;

    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOpen);

      if (keyboardOpen && this.state.needsBottomFocusHandling) {
        // Use a slightly longer timeout to ensure all layout changes have settled.
        setTimeout(() => this.handleBottomFocusScenario(), 150);
      }
    }
  }

  /**
   * REFACTORED: This is now much simpler and more robust.
   * It calculates the desired scroll position to bring the focused element
   * into a comfortable viewing area, rather than calculating from the toolbar up.
   */
  handleBottomFocusScenario() {
    if (!this.state.needsBottomFocusHandling) return;

    const mainContent = document.querySelector(".main-content");
    if (!mainContent || !this.state.focusedElement) return;

    console.log("🔧 Handling bottom focus scenario");

    const mainContentRect = mainContent.getBoundingClientRect();
    const visibleHeight = mainContentRect.height;

    // Goal: Position the focused element about 40% from the top of the visible area.
    const desiredTopOffset = visibleHeight * 0.4;

    // Calculate the required scroll position to achieve this.
    const newScrollTop =
      this.state.elementOffsetFromContentTop - desiredTopOffset;

    console.log("📜 Bottom focus scroll calculation", {
      elementOffset: this.state.elementOffsetFromContentTop,
      desiredTopOffset,
      newScrollTop,
    });

    mainContent.scrollTop = Math.max(0, newScrollTop);
    this.state.needsBottomFocusHandling = false;
  }

  /**
   * REFACTORED: This function is now dramatically simpler.
   * It NO LONGER touches the main layout elements (logo, main-content).
   * It only manages the toolbars and the content padding.
   */
  adjustLayout(keyboardOpen) {
    const mainContent = document.querySelector(".main-content");
    const editToolbar = document.querySelector("#edit-toolbar");
    const navButtons = document.querySelector("#nav-buttons");

    if (keyboardOpen) {
      // Store the original padding if we haven't already
      if (this.state.originalMainContentPaddingBottom === null && mainContent) {
        this.state.originalMainContentPaddingBottom =
          window.getComputedStyle(mainContent).paddingBottom;
      }

      // Calculate keyboard position using the visual viewport
      const vv = window.visualViewport;
      this.state.keyboardTop = vv.offsetTop + vv.height;

      // Move the toolbars into position
      this.moveToolbarAboveKeyboard(editToolbar, navButtons, mainContent);
    } else {
      // KEYBOARD CLOSED: Reset everything to its original CSS state.
      if (editToolbar) {
        editToolbar.removeEventListener(
          "touchstart",
          this.preventToolbarScroll,
          { passive: false },
        );
        editToolbar.removeEventListener("touchmove", this.preventToolbarScroll, {
          passive: false,
        });
      }
      if (navButtons) {
        navButtons.removeEventListener(
          "touchstart",
          this.preventToolbarScroll,
          { passive: false },
        );
        navButtons.removeEventListener("touchmove", this.preventToolbarScroll, {
          passive: false,
        });
      }

      // Reset only the styles we actually changed.
      this.resetInlineStyles(mainContent, editToolbar, navButtons);

      // Clear state
      this.state.originalMainContentPaddingBottom = null;
      this.state.keyboardTop = null;
      this.state.elementOffsetFromContentTop = null;
      this.state.focusedElementHeight = null;
      this.state.needsBottomFocusHandling = false;
    }
  }

  moveToolbarAboveKeyboard(toolbar, navButtons, mainContent) {
    if (!toolbar) return;

    const toolbarHeight = toolbar.getBoundingClientRect().height;
    const top = this.state.keyboardTop - toolbarHeight;

    toolbar.style.setProperty("position", "fixed", "important");
    toolbar.style.setProperty("top", `${top}px`, "important");
    toolbar.style.setProperty("left", "0", "important");
    toolbar.style.setProperty("right", "0", "important");
    toolbar.style.setProperty("z-index", "999999", "important");
    toolbar.style.setProperty("touch-action", "none", "important");

    toolbar.addEventListener("touchstart", this.preventToolbarScroll, {
      passive: false,
    });
    toolbar.addEventListener("touchmove", this.preventToolbarScroll, {
      passive: false,
    });

    if (mainContent) {
      // Create generous padding to allow content to scroll above the toolbar.
      const paddingBottom = toolbarHeight + 80;
      mainContent.style.setProperty(
        "padding-bottom",
        `${paddingBottom}px`,
        "important",
      );
    }

    if (navButtons) {
      navButtons.style.setProperty("position", "fixed", "important");
      navButtons.style.setProperty("top", `${top - 60}px`, "important"); // Position above edit toolbar
      navButtons.style.setProperty("right", "5px", "important");
      navButtons.style.setProperty("z-index", "999998", "important");
      navButtons.style.setProperty("touch-action", "none", "important");

      navButtons.addEventListener("touchstart", this.preventToolbarScroll, {
        passive: false,
      });
      navButtons.addEventListener("touchmove", this.preventToolbarScroll, {
        passive: false,
      });
    }
  }

  /**
   * REFACTORED: This now only resets the specific properties we changed on
   * the elements we actually touched. It leaves the main layout alone.
   */
  resetInlineStyles(...elements) {
    const toolbarProps = ["position", "top", "left", "right", "z-index", "touch-action"];
    
    elements.forEach((el) => {
      if (!el) return;
      
      if (el.id === 'main-content') {
        // Only reset padding-bottom on main-content
        el.style.removeProperty('padding-bottom');
      } else {
        // Reset all toolbar properties
        toolbarProps.forEach((p) => el.style.removeProperty(p));
      }
    });
  }

  destroy() {
    // ... (your destroy method is fine, just ensure it matches the new event listeners)
    window.removeEventListener("focusin", this.handleFocusIn, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.handleViewportChange,
      );
    }
  }
}

export { KeyboardManager };