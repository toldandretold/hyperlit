// keyboardManager.js - FINAL VERSION with Simple, Direct Check

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    this.state = {
      // REMOVED unnecessary state properties
      focusedElement: null,
    };

    // Bind methods
    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.preventToolbarScroll = this.preventToolbarScroll.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.checkAndScrollIfObscured =
      this.checkAndScrollIfObscured.bind(this);

    this.init();
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

  // SIMPLIFIED: This function now ONLY tracks the focused element.
  handleFocusIn(e) {
    if (
      e.target.isContentEditable ||
      ["INPUT", "TEXTAREA"].includes(e.target.tagName)
    ) {
      this.state.focusedElement = e.target;
    }
  }

  preventToolbarScroll(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  // MODIFIED: This now calls our simple check every time.
  handleViewportChange() {
    const vv = window.visualViewport;
    const referenceHeight = this.isIOS
      ? this.initialVisualHeight
      : window.innerHeight;
    const keyboardOpen = vv.height < referenceHeight * 0.9;

    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOpen);

      // If keyboard just opened, run our check after a delay.
      if (keyboardOpen) {
        // 300ms is a safer delay to ensure all browser animations are done.
        setTimeout(this.checkAndScrollIfObscured, 300);
      }
    }
  }

  // RENAMED & REFINED: This is the core logic you want.
  checkAndScrollIfObscured() {
    const focusedElement = this.state.focusedElement;
    const editToolbar = document.querySelector("#edit-toolbar");

    // If there's no focused element or toolbar, we can't do anything.
    if (!focusedElement || !editToolbar) {
      return;
    }

    console.log("🔎 Checking if cursor is obscured...");

    const elementRect = focusedElement.getBoundingClientRect();
    const toolbarRect = editToolbar.getBoundingClientRect();

    // The "danger zone" is any area covered by the toolbar.
    const obstructionTop = toolbarRect.top;

    // CONDITION: Is the bottom of the element hidden behind the toolbar?
    if (elementRect.bottom > obstructionTop) {
      console.log("✅ Obscured! Scrolling just enough to make it visible.");
      // 'nearest' is the correct, minimal-scroll option.
      focusedElement.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    } else {
      console.log("👍 Visible. No scroll needed.");
    }
  }

  // This function is now only called from handleViewportChange
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
        editToolbar.addEventListener("touchstart", this.preventToolbarScroll, {
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
      }
    } else {
      // KEYBOARD CLOSED: Reset everything
      if (editToolbar) {
        editToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      this.removeSpacer();
      this.resetInlineStyles(appContainer, mainContent, editToolbar);
    }
  }

  resetInlineStyles(...elements) {
    const props = [
      "position",
      "top",
      "left",
      "height",
      "padding-bottom",
      "z-index",
    ];
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
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.handleViewportChange,
      );
    }
  }
}

export { KeyboardManager };