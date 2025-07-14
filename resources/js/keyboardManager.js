// keyboardManager.js - A radically simpler approach

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

      if (keyboardIsOpenNow) {
        // Keyboard is open: add a spacer
        console.log("⌨️ Keyboard opened. Adding spacer.");
        const keyboardHeight = window.innerHeight - vv.height;
        this.createOrUpdateSpacer(keyboardHeight);
      } else {
        // Keyboard is closed: remove the spacer
        console.log("⌨️ Keyboard closed. Removing spacer.");
        this.removeSpacer();
      }
    }
  }

  createOrUpdateSpacer(height) {
    const scrollContainer = document.querySelector(".reader-content-wrapper");
    if (!scrollContainer) return;

    let spacer = document.querySelector("#keyboard-spacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "keyboard-spacer";
      // This is for debugging, makes the spacer visible
      // spacer.style.background = "rgba(255,0,0,0.2)";
      scrollContainer.appendChild(spacer);
    }
    // We only need to create enough space for the browser to scroll into.
    // The keyboard height is a good, simple value for this.
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
    this.removeSpacer(); // Cleanup
  }
}

export { KeyboardManager };