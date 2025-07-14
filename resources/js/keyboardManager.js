// keyboardManager.js - Combining the working toolbar pinning with the working spacer.

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.isKeyboardOpen = false;

    // Bind methods
    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.preventToolbarScroll = this.preventToolbarScroll.bind(this);
    this.init();
  }

  init() {
    if (!window.visualViewport) {
      console.warn("Visual Viewport API not supported");
      return;
    }
    window.visualViewport.addEventListener(
      "resize",
      this.handleViewportChange,
    );
  }

  preventToolbarScroll(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  handleViewportChange() {
    const vv = window.visualViewport;
    const keyboardIsOpenNow = vv.height < window.innerHeight * 0.9;

    if (keyboardIsOpenNow !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardIsOpenNow;
      this.adjustLayout(keyboardIsOpenNow);
    }
  }

  // This is the original function that correctly pinned the container and toolbar.
  adjustLayout(keyboardOpen) {
    const appContainer = document.querySelector("#app-container");
    const editToolbar = document.querySelector("#edit-toolbar");

    if (keyboardOpen) {
      const vv = window.visualViewport;

      // --- Part 1: Pin the entire app container (This stabilized the toolbar) ---
      if (appContainer) {
        appContainer.style.setProperty("position", "fixed", "important");
        appContainer.style.setProperty("top", `${vv.offsetTop}px`, "important");
        appContainer.style.setProperty("height", `${vv.height}px`, "important");
        appContainer.style.setProperty("width", "100%", "important");
        appContainer.style.setProperty("left", "0", "important");
      }

      // --- Part 2: Add the spacer (This fixed the scrolling) ---
      const keyboardHeight = window.innerHeight - vv.height;
      this.createOrUpdateSpacer(keyboardHeight);

      // --- Part 3: Position the toolbar within the pinned container ---
      this.moveToolbarAboveKeyboard(editToolbar, keyboardHeight);
    } else {
      // KEYBOARD CLOSED: Reset everything
      if (editToolbar) {
        editToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      this.removeSpacer();
      this.resetInlineStyles(appContainer, editToolbar);
    }
  }

  // This function correctly positions the toolbar above the keyboard.
  moveToolbarAboveKeyboard(toolbar, keyboardHeight) {
    if (!toolbar) return;
    const toolbarHeight = toolbar.getBoundingClientRect().height;

    toolbar.style.setProperty("position", "absolute", "important");
    // Position from the bottom of the fixed container, minus its own height
    toolbar.style.setProperty(
      "bottom",
      `${keyboardHeight + 1}px`,
      "important",
    );
    toolbar.style.setProperty("left", "0", "important");
    toolbar.style.setProperty("right", "0", "important");
    toolbar.style.setProperty("z-index", "9999", "important");
    toolbar.addEventListener("touchstart", this.preventToolbarScroll, {
      passive: false,
    });
  }

  // This function creates the scrollable space.
  createOrUpdateSpacer(height) {
    const scrollContainer = document.querySelector(".reader-content-wrapper");
    if (!scrollContainer) return;
    let spacer = document.querySelector("#keyboard-spacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "keyboard-spacer";
      scrollContainer.appendChild(spacer);
    }
    spacer.style.height = `${height}px`;
  }

  removeSpacer() {
    const spacer = document.querySelector("#keyboard-spacer");
    if (spacer) spacer.remove();
  }

  resetInlineStyles(...elements) {
    const props = [
      "position",
      "top",
      "left",
      "right",
      "bottom",
      "height",
      "width",
      "z-index",
    ];
    elements.forEach((el) => {
      if (!el) return;
      props.forEach((p) => el.style.removeProperty(p));
    });
  }

  destroy() {
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.handleViewportChange,
      );
    }
    this.adjustLayout(false); // Ensure everything is reset
  }
}

export { KeyboardManager };