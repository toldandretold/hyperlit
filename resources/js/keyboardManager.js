// This is your working code, with the "bad guess" removed and the scroll call made reliable.

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    this.state = {
      // REMOVED needsBottomFocusHandling and other unnecessary state
      focusedElement: null,
      keyboardTop: null,
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

  preventToolbarScroll(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  // MODIFIED: This now triggers the scroll command reliably.
handleViewportChange() {
  const vv = window.visualViewport;
  const referenceHeight = this.isIOS
    ? this.initialVisualHeight
    : window.innerHeight;
  const keyboardOpen = vv.height < referenceHeight * 0.9;

  if (keyboardOpen !== this.isKeyboardOpen) {
    this.isKeyboardOpen = keyboardOpen;
    this.adjustLayout(keyboardOpen);

    // --- FIXED VERSION ---
    // If the keyboard just opened AND we have a focused element...
    if (keyboardOpen && this.state.focusedElement) {
      // ...then after a delay, scroll it into view if it's actually blocked.
      setTimeout(() => {
        if (this.state.focusedElement) {
          console.log("✅ Checking if element needs scrolling.");
          this.scrollElementIfBlocked(this.state.focusedElement);
        }
      }, 300);
    }
  }
}

// NEW METHOD: Only scroll if element is actually blocked by keyboard/toolbar
scrollElementIfBlocked(element) {
  const scrollContainer = document.querySelector(".reader-content-wrapper");
  if (!scrollContainer) return;

  const elementRect = element.getBoundingClientRect();
  const toolbar = document.querySelector("#edit-toolbar");
  const toolbarHeight = toolbar ? toolbar.getBoundingClientRect().height : 0;
  
  // Calculate where the keyboard+toolbar starts (this is what blocks the view)
  const blockingTop = this.state.keyboardTop - toolbarHeight;
  
  // Only scroll if the element's TOP is below the blocking area
  // (meaning it's completely hidden, not just partially)
  if (elementRect.top > blockingTop) {
    console.log("Element is completely blocked by keyboard/toolbar, scrolling...");
    // Calculate how much we need to scroll up to show the element
    const scrollAmount = elementRect.top - blockingTop + 20; // 20px buffer
    
    scrollContainer.scrollBy({
      top: scrollAmount,
      behavior: "smooth"
    });
  } else {
    console.log("Element is visible, no scrolling needed.");
  }
}
  

  // All the functions below are from YOUR working version. They are unchanged.
  adjustLayout(keyboardOpen) {
    const appContainer = document.querySelector("#app-container");
    const mainContent = document.querySelector(".main-content");
    const editToolbar = document.querySelector("#edit-toolbar");
    const navButtons = document.querySelector("#nav-buttons");

    if (keyboardOpen) {
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
      this.moveToolbarAboveKeyboard(editToolbar, navButtons, mainContent);
    } else {
      if (editToolbar) {
        editToolbar.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      if (navButtons) {
        navButtons.removeEventListener("touchstart", this.preventToolbarScroll);
      }
      this.removeSpacer();
      this.resetInlineStyles(appContainer, mainContent, editToolbar, navButtons);
      this.state.keyboardTop = null;
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