// keyboardManager.js

class KeyboardManager {
  constructor() {
    // No changes to the constructor
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.isKeyboardOpen = false;
    this.focusedElement = null;

    // Bind methods
    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.handleFocusOut = this.handleFocusOut.bind(this);

    this.init();
  }

  init() {
    if (!window.visualViewport) {
      console.warn("Visual Viewport API not supported, keyboard manager disabled.");
      return;
    }
    // Listen for viewport changes to detect keyboard
    window.visualViewport.addEventListener("resize", this.handleViewportChange);
    // Track focused elements
    window.addEventListener("focusin", this.handleFocusIn, true);
    window.addEventListener("focusout", this.handleFocusOut, true);
  }

  handleFocusIn(e) {
    // Store the element that was just focused
    if (
      e.target.isContentEditable ||
      ["INPUT", "TEXTAREA"].includes(e.target.tagName)
    ) {
      this.focusedElement = e.target;
    }
  }

  handleFocusOut() {
    this.focusedElement = null;
  }

  handleViewportChange() {
    const vv = window.visualViewport;
    // A common heuristic to detect if the keyboard is open
    const keyboardIsOpenNow = vv.height < window.innerHeight * 0.9;

    // Check if the keyboard state has changed
    if (keyboardIsOpenNow !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardIsOpenNow;
      if (keyboardIsOpenNow) {
        this.onKeyboardOpen();
      } else {
        this.onKeyboardClose();
      }
    }
  }

  /**
   * NEW: Logic for when the keyboard opens.
   */
  onKeyboardOpen() {
    console.log("⌨️ Keyboard opened");
    const vv = window.visualViewport;

    // 1. Calculate heights
    const keyboardHeight = window.innerHeight - vv.height;
    const toolbar = document.querySelector("#edit-toolbar");
    const toolbarHeight = toolbar?.offsetHeight || 0;

    // 2. Create and size the spacer div
    // The spacer creates the artificial scroll room needed.
    const spacerHeight = keyboardHeight; // Spacer only needs to be keyboard height
    this.createOrUpdateSpacer(spacerHeight);

    // 3. Position the toolbar above the keyboard
    if (toolbar) {
      toolbar.style.setProperty("position", "fixed", "important");
      toolbar.style.setProperty("bottom", `${keyboardHeight}px`, "important");
      toolbar.style.setProperty("left", "0", "important");
      toolbar.style.setProperty("right", "0", "important");
      toolbar.style.setProperty("z-index", "1000", "important");
    }

    // 4. Scroll the focused element into view
    // A timeout is crucial to wait for the browser's keyboard animation to finish.
    setTimeout(() => {
      if (this.focusedElement) {
        this.focusedElement.scrollIntoView({
          behavior: "smooth",
          block: "center", // 'center' is often best to give context above/below
        });
      }
    }, 300);
  }

  /**
   * NEW: Logic for when the keyboard closes.
   */
  onKeyboardClose() {
    console.log("⌨️ Keyboard closed");

    // 1. Remove the spacer
    document.querySelector("#keyboard-spacer")?.remove();

    // 2. Reset toolbar styles
    const toolbar = document.querySelector("#edit-toolbar");
    if (toolbar) {
      toolbar.style.removeProperty("position");
      toolbar.style.removeProperty("bottom");
      toolbar.style.removeProperty("left");
      toolbar.style.removeProperty("right");
      toolbar.style.removeProperty("z-index");
    }
  }

  /**
   * NEW: Helper function to manage the spacer element.
   */
  createOrUpdateSpacer(height) {
    const mainContent = document.querySelector(".main-content");
    if (!mainContent) return;

    let spacer = document.querySelector("#keyboard-spacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "keyboard-spacer";
      // Add some styles for debugging if you want
      // spacer.style.backgroundColor = 'rgba(255, 0, 0, 0.2)';
      mainContent.appendChild(spacer);
    }
    spacer.style.height = `${height}px`;
  }

  destroy() {
    // Cleanup listeners
    window.removeEventListener("focusin", this.handleFocusIn, true);
    window.removeEventListener("focusout", this.handleFocusOut, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.handleViewportChange,
      );
    }
    // Ensure styles are reset if the manager is destroyed while keyboard is open
    this.onKeyboardClose();
  }
}

export { KeyboardManager };