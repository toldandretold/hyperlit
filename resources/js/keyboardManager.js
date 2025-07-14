// keyboardManager.js - A new approach focusing only on the toolbar and spacer.

class KeyboardManager {
  constructor() {
    this.isKeyboardOpen = false;
    this.init();
  }

  init() {
    if (!window.visualViewport) {
      console.warn("Visual Viewport API not supported, manager disabled.");
      return;
    }
    // Bind the context of 'this' for the event listener
    this.handleViewportChange = this.handleViewportChange.bind(this);
    window.visualViewport.addEventListener("resize", this.handleViewportChange);
  }

  handleViewportChange() {
    const vv = window.visualViewport;
    const keyboardIsOpenNow = vv.height < window.innerHeight * 0.9;

    // Only act if the keyboard state changes
    if (keyboardIsOpenNow !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardIsOpenNow;
      this.adjustLayout(keyboardIsOpenNow);
    }
  }

  adjustLayout(isOpening) {
    const toolbar = document.querySelector("#edit-toolbar");
    const scrollContainer = document.querySelector(".reader-content-wrapper");

    if (isOpening) {
      console.log("⌨️ Keyboard opened. Fixing toolbar, adding spacer.");
      const keyboardHeight = window.innerHeight - window.visualViewport.height;
      const toolbarHeight = toolbar ? toolbar.offsetHeight : 0;

      // --- 1. Fix the toolbar to the viewport ---
      if (toolbar) {
        toolbar.style.position = "fixed";
        toolbar.style.bottom = `${keyboardHeight}px`;
        toolbar.style.left = "0";
        toolbar.style.right = "0";
        toolbar.style.zIndex = "1000";
      }

      // --- 2. Create a spacer tall enough for the keyboard AND the toolbar ---
      const totalSpacerHeight = keyboardHeight + toolbarHeight;
      this.createOrUpdateSpacer(scrollContainer, totalSpacerHeight);
    } else {
      console.log("⌨️ Keyboard closed. Resetting everything.");
      // --- 1. Un-fix the toolbar ---
      if (toolbar) {
        toolbar.style.position = "";
        toolbar.style.bottom = "";
        toolbar.style.left = "";
        toolbar.style.right = "";
        toolbar.style.zIndex = "";
      }

      // --- 2. Remove the spacer ---
      this.removeSpacer();
    }
  }

  createOrUpdateSpacer(container, height) {
    if (!container) return;
    let spacer = document.querySelector("#keyboard-spacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "keyboard-spacer";
      container.appendChild(spacer);
    }
    spacer.style.height = `${height}px`;
  }

  removeSpacer() {
    const spacer = document.querySelector("#keyboard-spacer");
    if (spacer) {
      spacer.remove();
    }
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