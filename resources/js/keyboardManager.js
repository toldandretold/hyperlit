// keyboardManager.js - Combines working spacer with working toolbar logic

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

    if (keyboardIsOpenNow !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardIsOpenNow;

      if (keyboardIsOpenNow) {
        console.log("⌨️ Keyboard opened. Adding spacer and positioning toolbar.");
        // --- Part 1: The Spacer (This works) ---
        const keyboardHeight = window.innerHeight - vv.height;
        this.createOrUpdateSpacer(keyboardHeight);

        // --- Part 2: Position the Toolbar (Bringing this back) ---
        const toolbar = document.querySelector("#edit-toolbar");
        if (toolbar) {
          const toolbarHeight = toolbar.getBoundingClientRect().height;
          // Calculate where the top of the toolbar should be
          const toolbarTop = vv.offsetTop + vv.height - toolbarHeight;

          toolbar.style.setProperty("position", "fixed", "important");
          toolbar.style.setProperty("top", `${toolbarTop}px`, "important");
          toolbar.style.setProperty("left", "0", "important");
          toolbar.style.setProperty("right", "0", "important");
          toolbar.style.setProperty("z-index", "9999", "important");
        }
      } else {
        console.log("⌨️ Keyboard closed. Removing spacer and resetting toolbar.");
        // --- Part 1: Remove the Spacer ---
        this.removeSpacer();

        // --- Part 2: Reset the Toolbar ---
        const toolbar = document.querySelector("#edit-toolbar");
        if (toolbar) {
          toolbar.style.removeProperty("position");
          toolbar.style.removeProperty("top");
          toolbar.style.removeProperty("left");
          toolbar.style.removeProperty("right");
          toolbar.style.removeProperty("z-index");
        }
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
      scrollContainer.appendChild(spacer);
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
    this.removeSpacer(); // Cleanup
    // Also reset toolbar on destroy
    const toolbar = document.querySelector("#edit-toolbar");
    if (toolbar) {
      toolbar.style.removeProperty("position");
      toolbar.style.removeProperty("top");
      toolbar.style.removeProperty("left");
      toolbar.style.removeProperty("right");
      toolbar.style.removeProperty("z-index");
    }
  }
}

export { KeyboardManager };