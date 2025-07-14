// keyboardManager.js

class KeyboardManager {
  // ... constructor, init, handleFocusIn, preventToolbarScroll are all correct and unchanged ...
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
  }

  handleFocusIn(e) {
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
    const referenceHeight = this.isIOS
      ? this.initialVisualHeight
      : window.innerHeight;
    const keyboardOpen = vv.height < referenceHeight * 0.9;

    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOpen);

      if (keyboardOpen && this.state.needsBottomFocusHandling) {
        setTimeout(() => this.handleBottomFocusScenario(), 150);
      }
    }
  }

  handleBottomFocusScenario() {
    if (!this.state.needsBottomFocusHandling || !this.state.focusedElement) {
      return;
    }
    console.log("🔧 Handling bottom focus scenario (with spacer)");
    // This logic is now reliable because the spacer div exists.
    this.state.focusedElement.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    this.state.needsBottomFocusHandling = false;
  }

  /**
   * MODIFIED VERSION: Integrates the spacer logic.
   */
  adjustLayout(keyboardOpen) {
    const appContainer = document.querySelector("#app-container");
    const mainContent = document.querySelector(".main-content");
    const editToolbar = document.querySelector("#edit-toolbar");
    const navButtons = document.querySelector("#nav-buttons");

    if (keyboardOpen) {
      const vv = window.visualViewport;

      // --- YOUR EXISTING LOGIC (UNCHANGED) ---
      if (appContainer) {
        appContainer.style.setProperty("position", "fixed", "important");
        appContainer.style.setProperty("top", `${vv.offsetTop}px`, "important");
        appContainer.style.setProperty("height", `${vv.height}px`, "important");
        appContainer.style.setProperty("width", "100%", "important");
        appContainer.style.setProperty("left", "0", "important");
        appContainer.style.setProperty("z-index", "1", "important");
      }
      // --- END OF YOUR EXISTING LOGIC ---

      // ✨ NEW: Add the spacer to create scroll room
      const keyboardHeight = window.innerHeight - vv.height;
      this.createOrUpdateSpacer(keyboardHeight);

      if (this.state.originalMainContentPaddingBottom === null && mainContent) {
        this.state.originalMainContentPaddingBottom =
          window.getComputedStyle(mainContent).paddingBottom;
      }

      this.state.keyboardTop = vv.offsetTop + vv.height;
      this.moveToolbarAboveKeyboard(editToolbar, navButtons, mainContent);
    } else {
      // KEYBOARD CLOSED: Reset everything
      if (editToolbar) {
        editToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      if (navButtons) {
        navButtons.removeEventListener("touchstart", this.preventToolbarScroll);
      }

      // ✨ NEW: Remove the spacer on close
      this.removeSpacer();

      this.resetInlineStyles(appContainer, mainContent, editToolbar, navButtons);

      this.state.originalMainContentPaddingBottom = null;
      this.state.keyboardTop = null;
      this.state.needsBottomFocusHandling = false;
    }
  }

  // This method is unchanged
  moveToolbarAboveKeyboard(toolbar, navButtons, mainContent) {
    if (!toolbar) return;
    const toolbarHeight = toolbar.getBoundingClientRect().height;
    const top = this.state.keyboardTop - toolbarHeight;

    toolbar.style.setProperty("position", "fixed", "important");
    toolbar.style.setProperty("top", `${top}px`, "important");
    toolbar.style.setProperty("left", "0", "important");
    toolbar.style.setProperty("right", "0", "important");
    toolbar.style.setProperty("z-index", "999999", "important");
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

    if (navButtons) {
      navButtons.style.setProperty("position", "fixed", "important");
      navButtons.style.setProperty("top", `${top - 60}px`, "important");
      navButtons.style.setProperty("right", "5px", "important");
      navButtons.style.setProperty("z-index", "999998", "important");
      navButtons.addEventListener("touchstart", this.preventToolbarScroll, {
        passive: false,
      });
    }
  }

  // This method is unchanged
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

  // ✨ NEW: Helper function to manage the spacer element.
  // THIS IS THE NEW, CORRECTED FUNCTION
  createOrUpdateSpacer(height) {
    // CHANGE 1: Look for the new wrapper class instead of .main-content
    const scrollContainer = document.querySelector(".reader-content-wrapper");

    // If the wrapper doesn't exist (e.g., on the home page), do nothing.
    if (!scrollContainer) {
      return;
    }

    let spacer = document.querySelector("#keyboard-spacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "keyboard-spacer";
      // CHANGE 2: Append the spacer to the wrapper, not the editable div.
      scrollContainer.appendChild(spacer);
    }
    spacer.style.height = `${height}px`;
  }

  // ✨ NEW: Helper function to remove the spacer.
  removeSpacer() {
    const spacer = document.querySelector("#keyboard-spacer");
    if (spacer) {
      spacer.remove();
    }
  }

  // This method is unchanged
  destroy() {
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