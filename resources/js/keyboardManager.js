// keyboardManager.js - FINAL, SIMPLIFIED VERSION

class KeyboardManager {
  constructor() {
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
      console.warn("Visual Viewport API not supported");
      return;
    }
    window.visualViewport.addEventListener(
      "resize",
      this.handleViewportChange,
    );
    window.addEventListener("focusin", this.handleFocusIn, true);
    window.addEventListener("focusout", this.handleFocusOut, true);
  }

  // This just tracks the focused element.
  handleFocusIn(e) {
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

  // SIMPLIFIED: This now calls a simple scroll command every time.
  handleViewportChange() {
    const vv = window.visualViewport;
    const keyboardIsOpenNow = vv.height < window.innerHeight * 0.9;

    if (keyboardIsOpenNow !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardIsOpenNow;
      this.adjustLayout(keyboardIsOpenNow);

      if (keyboardIsOpenNow && this.focusedElement) {
        console.log("⌨️ Keyboard opened, ensuring element is visible...");
        // After a delay, unconditionally ask the browser to scroll if needed.
        setTimeout(() => {
          if (this.focusedElement) {
            this.focusedElement.scrollIntoView({
              behavior: "smooth",
              block: "nearest", // 'nearest' is the key to safe scrolling
            });
          }
        }, 300);
      }
    }
  }

  adjustLayout(keyboardOpen) {
    const appContainer = document.querySelector("#app-container");
    const mainContent = document.querySelector(".main-content");
    const editToolbar = document.querySelector("#edit-toolbar");

    if (keyboardOpen) {
      const vv = window.visualViewport;
      if (appContainer) {
        appContainer.style.setProperty("position", "fixed", "important");
        appContainer.style.setProperty("top", `${vv.offsetTop}px`, "important");
        appContainer.style.setProperty("height", `${vv.height}px`, "important");
      }

      const keyboardHeight = window.innerHeight - vv.height;
      this.createOrUpdateSpacer(keyboardHeight);

      if (editToolbar) {
        const toolbarHeight = editToolbar.getBoundingClientRect().height;
        const toolbarTop = vv.offsetTop + vv.height - toolbarHeight;
        editToolbar.style.setProperty("position", "fixed", "important");
        editToolbar.style.setProperty("top", `${toolbarTop}px`, "important");
        editToolbar.style.setProperty("left", "0", "important");
        editToolbar.style.setProperty("right", "0", "important");
        editToolbar.style.setProperty("z-index", "999999", "important");
      }
    } else {
      this.removeSpacer();
      this.resetInlineStyles(appContainer, mainContent, editToolbar);
    }
  }

  resetInlineStyles(...elements) {
    const props = ["position", "top", "height", "z-index"];
    elements.forEach((el) => {
      if (!el) return;
      props.forEach((p) => el.style.removeProperty(p));
    });
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
    if (spacer) spacer.remove();
  }

  destroy() {
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