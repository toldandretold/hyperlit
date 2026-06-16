// NewBookContainerManager — the #newbook-container panel opened by #newBookButton.
// Owns the open/close animation state machine, the two in-panel buttons
// (#createNewBook → SPA create, #importBook → inject the cite-form), and the
// container's own draft helpers (localStorage key 'newbook-form-data'). It's one
// cohesive lifecycle concern, so (unlike userContainer) it stays a single class.
// The cite-form HTML comes from ./citeForm/template; its behavior is lazy-loaded
// from ./citeForm when the import form opens. Registry lifecycle + the
// default-export singleton live in ../newBookButton/newBookButton.
import { ContainerManager } from "../utilities/containerManager";
import { log, verbose } from "../../utilities/logger";
import { getCiteFormHTML } from "./citeForm/template";

const byId = (id: string): any => document.getElementById(id);
const sel = (s: string): any => document.querySelector(s);

export class NewBookContainerManager extends (ContainerManager as any) {
  constructor(
    containerId: any,
    overlayId: any,
    buttonId: any,
    frozenContainerIds: any = [],
  ) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.setupNewBookContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.buttonPosition = null;
    this.originalButtonRect = null; // Store original button position

    // Store event handler references for proper cleanup
    this.createBookHandler = null;
    this.importBookHandler = null;

    // Track animation timeout to prevent stuck state
    this.animationTimeout = null;
    this.transitionEndHandler = null;

    // Track external link clicks to prevent inappropriate closure
    this.recentExternalLinkClick = false;

    // Store resize handler reference for lazy initialization and cleanup
    this.resizeHandler = null;

    this.setupButtonListeners();
    this.originalContent = null;

    // Resize listener will be initialized lazily when import form is opened

    this.boundVisibilityChangeHandler = this.handleVisibilityChange.bind(this);
    this.boundFocusHandler = this.handleFocus.bind(this);

    document.addEventListener('visibilitychange', this.boundVisibilityChangeHandler);
    window.addEventListener('focus', this.boundFocusHandler);
  }

  handleVisibilityChange() {
    if (!document.hidden && this.recentExternalLinkClick) {
      verbose.init('Page visible again after external link click - preserving form state', 'newBookButton.js');
      this.recentExternalLinkClick = false;
      return; // Don't let other handlers close the form
    }
  }

  handleFocus() {
    if (this.recentExternalLinkClick) {
      verbose.init('Page focused after external link click - preserving form state', 'newBookButton.js');
      this.recentExternalLinkClick = false;
      return;
    }
  }

  destroy() {
    document.removeEventListener('visibilitychange', this.boundVisibilityChangeHandler);
    window.removeEventListener('focus', this.boundFocusHandler);
    this.cleanupResizeListener();
    this.resetAnimationState(); // Clean up any pending animation state
    verbose.init('All global listeners removed', 'newBookButton.js');
  }

  setupResizeListener() {
    // Only set up the resize listener if it hasn't been created yet
    if (!this.resizeHandler) {
      this.resizeHandler = () => {
        if (this.isOpen && this.container?.querySelector('#cite-form')) {
          // If form is open, adjust size on resize
          this.setResponsiveFormSize();
        }
      };
      window.addEventListener('resize', this.resizeHandler);
    }
  }

  cleanupResizeListener() {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  setupNewBookContainerStyles() {
    const container = this.container;
    if (!container) return;

    // CLOSED state only:
    container.style.position = "fixed"; // so we can animate from 0→XYZ
    container.style.transition =
      "width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out, top 0.3s ease-out, left 0.3s ease-out, right 0.3s ease-out";
    container.style.zIndex = "1001";
    // backgroundColor handled by CSS using var(--container-glass-bg)
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
    container.style.borderRadius = "0.75em";

    // start hidden/collapsed:
    container.style.opacity = "0";
    container.style.padding = "12px";
    container.style.width = "0";
    container.style.height = "0";
  }

  /**
   * Robust animation reset - clears all pending timeouts and listeners
   * Prevents stuck animation state from rapid clicking
   */
  resetAnimationState() {
    // Clear any pending timeout
    if (this.animationTimeout) {
      clearTimeout(this.animationTimeout);
      this.animationTimeout = null;
    }

    // Remove any pending transitionend listener
    if (this.transitionEndHandler) {
      this.container.removeEventListener("transitionend", this.transitionEndHandler);
      this.transitionEndHandler = null;
    }

    // Reset the flag
    this.isAnimating = false;
  }

  setupButtonListeners() {
    // Remove existing event listeners if they exist
    if (this.createBookHandler) {
      document.getElementById("createNewBook")?.removeEventListener("click", this.createBookHandler);
    }
    if (this.importBookHandler) {
      document.getElementById("importBook")?.removeEventListener("click", this.importBookHandler);
    }

    // Create and store event handler functions
    this.createBookHandler = async () => {
      verbose.init('Create new book clicked', 'newBookButton.js');
      this.closeContainer();

      try {
        // Use NavigationManager to ensure overlay lifecycle is managed correctly
        const { NavigationManager } = await import('../../SPA/navigation/NavigationManager');
        await NavigationManager.navigate('create-new-book', { createAndTransition: true });
        log.init('New book transition completed successfully', 'newBookButton.js');
      } catch (error) {
        console.error("❌ New book creation failed:", error);
        // Could show user feedback here
      }
    };

    this.importBookHandler = () => {
      verbose.init('Import book clicked', 'newBookButton.js');
      // Save the original content if not already saved
      if (!this.originalContent) {
        this.originalContent = this.container.innerHTML;
      }

      // ✅ LAZY INITIALIZATION: Set up resize listener only when form is opened
      this.setupResizeListener();

      // Replace content with the form
      this.showImportForm();

      // ✅ NOW OPEN THE CONTAINER IN FORM MODE
      this.openContainer("form");

      // ✅ FIX: Wait for container animation to complete before setting up form
      // Defensive wait — the form should be in the DOM the moment
      // showImportForm() returns, but during rapid open/close cycles or under
      // animation pressure getElementById can briefly miss it. Retry quietly;
      // only log at error level if we exhaust a generous retry budget.
      let retryCount = 0;
      const SETUP_FORM_MAX_RETRIES = 200; // 10s @ 50ms/retry — generous; the
                                          // form normally appears on retry 1-3
      const setupForm = () => {
        // If the container was closed while we were waiting (e.g. the user
        // dismissed it, or a close interrupted the open animation), abort
        // quietly — there's no form to wire up and it isn't an error.
        if (!this.isOpen) return;
        const form = document.getElementById('cite-form');
        if (!form) {
          if (++retryCount > SETUP_FORM_MAX_RETRIES) {
            console.error(`Import form failed to render after ${SETUP_FORM_MAX_RETRIES} retries`);
            return;
          }
          setTimeout(setupForm, 50);
          return;
        }

        import("./citeForm/index")
          .then(module => {
            // Call the initialization function from the imported module
            module.initializeCitationFormListeners();

            // Set up the form submission handler explicitly
            module.setupFormSubmissionHandler();
          })
          .catch(error => {
            console.error("Error importing citation form module:", error);
          });
      };

      // Wait for the next animation frame to ensure DOM is ready
      requestAnimationFrame(() => {
        // Add a small delay to ensure mobile animations don't interfere
        setTimeout(setupForm, 100);
      });
    };

    // Add the event listeners
    document.getElementById("createNewBook")?.addEventListener("click", this.createBookHandler);
    document.getElementById("importBook")?.addEventListener("click", this.importBookHandler);

    // Add hover effects - both buttons aqua on hover
    const createBtn = byId("createNewBook");
    if (createBtn) {
      createBtn.addEventListener('mouseenter', () => {
        createBtn.style.backgroundColor = 'var(--color-accent)';
        createBtn.style.color = 'var(--color-background)';
      });
      createBtn.addEventListener('mouseleave', () => {
        createBtn.style.backgroundColor = '#4a4a4a';
        createBtn.style.color = '#CBCCCC';
      });
    }

    const importBtn = byId("importBook");
    if (importBtn) {
      importBtn.addEventListener('mouseenter', () => {
        importBtn.style.backgroundColor = 'var(--color-accent)';
        importBtn.style.color = 'var(--color-background)';
      });
      importBtn.addEventListener('mouseleave', () => {
        importBtn.style.backgroundColor = '#4a4a4a';
        importBtn.style.color = '#CBCCCC';
      });
    }
  }

  showImportForm() {
    // The cite-form HTML lives in ./citeForm/template; behavior is wired by
    // ./citeForm (lazy-loaded in importBookHandler after this injects the form).
    const formHTML = getCiteFormHTML();

    // Replace the container content
    this.container.innerHTML = formHTML;

    // Let openContainer() handle all positioning and display logic
    // Remove alignment styles from flex usage, if any.
    this.container.style.flexDirection = "";
    this.container.style.justifyContent = "";
    this.container.style.alignItems = "";
    this.container.style.gap = "";

    // In case elements like a close button are needed,
    // re-attach event listeners if elements exist (for now, for example).
    sel(".close-button")?.addEventListener("click", () => {
      this.restoreOriginalContent();
    });

    // If there is an element to cancel the form, reattach
    byId("cancelImport")?.addEventListener("click", () => {
      this.restoreOriginalContent();
    });

    byId("clearButton")?.addEventListener("click", () => {
      byId("cite-form").reset();
      this.clearSavedFormData();
    });

    // Show/hide optional fields based on the selected type
    const typeRadios = document.querySelectorAll('input[name="type"]');
    typeRadios.forEach((radio: any) => {
      radio.addEventListener("change", () => {
        this.toggleOptionalFields(radio.value);
      });
    });

    // Set default type and ensure URL field is visible
    if (typeRadios.length > 0) {
      // Find the checked radio or default to first one
      const checkedRadio = sel('input[name="type"]:checked');
      if (checkedRadio) {
        this.toggleOptionalFields(checkedRadio.value);
      } else {
        (typeRadios[0] as any).checked = true;
        this.toggleOptionalFields((typeRadios[0] as any).value);
      }
    }

    // Always ensure URL field is visible after initialization
    setTimeout(() => {
      const urlField = byId('url');
      if (urlField) {
        urlField.style.display = 'block';

        // Add URL auto-formatting
        urlField.addEventListener('blur', function(this: any) {
          let url = this.value.trim();
          if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            this.value = 'https://' + url;
          }
        });
      }
    }, 50);

    this.loadFormData();

    const form = byId('cite-form');
    if (form) {
      form.addEventListener('input', () => {
        // Debounce the save to avoid too many localStorage writes
        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
          this.saveFormData();
        }, 500);
      });
    }
  }

  setResponsiveFormSize() {
    const isMobile = window.innerWidth <= 480;
    const isLeftAnchored = !!this.button.closest('#logoNavMenu');

    if (isMobile) {
      // Mobile: full-width sheet on left-anchored (reader); right-edge-sized
      // on right-anchored (home/user) per the historical behaviour.
      const maxWidth = isLeftAnchored
        ? window.innerWidth - 30
        : this.originalButtonRect.right - 15;

      this.container.style.width = `${maxWidth}px`;
      this.container.style.height = "calc(100vh - 100px)";
      this.container.style.maxWidth = `${maxWidth}px`;

      this.container.style.left = "15px";
      this.container.style.right = ""; // Clear right positioning
      this.container.style.top = "50px";
    } else {
      // Desktop: Keep existing size
      this.container.style.width = "500px";
      this.container.style.height = "80vh";
      this.container.style.maxWidth = "500px";

      // Keep existing positioning logic for desktop
      // (this will be set by openContainer method)
    }
  }

  toggleOptionalFields(type: any) {
    // Hide all optional fields first
    const optionalFields = document.querySelectorAll(".optional-field");
    optionalFields.forEach((field: any) => {
      field.style.display = "none";
    });

    // Always show common fields like URL
    const urlField = byId('url');
    if (urlField) urlField.style.display = 'block';

    // Show fields based on type
    switch (type) {
      case "article":
        sel('label[for="journal"]').style.display = "block";
        byId("journal").style.display = "block";
        sel('label[for="volume"]').style.display = "block";
        byId("volume").style.display = "block";
        sel('label[for="issue"]').style.display = "block";
        byId("issue").style.display = "block";
        sel('label[for="pages"]').style.display = "block";
        byId("pages").style.display = "block";
        break;
      case "book":
        sel('label[for="publisher"]').style.display = "block";
        byId("publisher").style.display = "block";
        sel('label[for="pages"]').style.display = "block";
        byId("pages").style.display = "block";
        break;
      case "incollection":
        sel('label[for="booktitle"]').style.display = "block";
        byId("booktitle").style.display = "block";
        sel('label[for="editor"]').style.display = "block";
        byId("editor").style.display = "block";
        sel('label[for="publisher"]').style.display = "block";
        byId("publisher").style.display = "block";
        sel('label[for="chapter"]').style.display = "block";
        byId("chapter").style.display = "block";
        sel('label[for="pages"]').style.display = "block";
        byId("pages").style.display = "block";
        break;
      case "phdthesis":
        sel('label[for="school"]').style.display = "block";
        byId("school").style.display = "block";
        break;
      case "misc":
        sel('label[for="note"]').style.display = "block";
        byId("note").style.display = "block";
        break;
    }
  }

  restoreOriginalContent() {
    if (this.originalContent) {
      // Restore the original content (the two buttons)
      this.container.innerHTML = this.originalContent;

      // Resize the container back to its original size
      this.container.style.width = "150px";
      this.container.style.height = "100px";
      this.container.style.overflow = "hidden";

      // Re-attach event listeners to the buttons
      this.setupButtonListeners();
    }
  }

  openContainer(mode = "buttons") {
    console.log("🔥 DEBUG: openContainer called", { mode, isOpen: this.isOpen, isAnimating: this.isAnimating });

    // Safety check: if animation has been stuck for >1 second, force reset
    if (this.isAnimating && this.animationTimeout) {
      // Animation is in progress, check if it's been too long
      console.warn("⚠️ Animation in progress, blocking openContainer");
      return;
    } else if (this.isAnimating && !this.animationTimeout) {
      // No timeout set but still animating? Something's wrong, force reset
      console.warn("⚠️ Stuck animation state detected, forcing reset");
      this.resetAnimationState();
    }

    // 🔥 MOBILE FIX: Reset any stuck states that could cause glitches
    if (!this.isOpen) {
      console.log("🔥 MOBILE: Resetting container state for fresh open");
      this.container.style.display = "none";
      this.container.style.opacity = "0";
      this.container.style.width = "0";
      this.container.style.height = "0";
      this.container.style.visibility = "hidden";
      this.container.classList.remove("hidden");

      // Clear any residual positioning
      this.container.style.left = "";
      this.container.style.right = "";
      this.container.style.top = "";
      this.container.style.transform = "";
    }

    this.isAnimating = true;
    this.animationType = "open";

    const isMobile = window.innerWidth <= 480;
    const rect = this.button.getBoundingClientRect();
    // Button lives in the reader's logo nav menu on the LEFT side of the screen,
    // so anchor the popup's left edge to the button instead of the right.
    const isLeftAnchored = !!this.button.closest('#logoNavMenu');

    console.log("🔥 DEBUG: openContainer state", { isMobile, isLeftAnchored, rect, originalButtonRect: this.originalButtonRect });

    // This logic handles the TRANSITION from the initial "buttons" view to the "form" view.
    // It assumes the container is already open.
    if (this.isOpen && mode === "form") {
      console.log("🔥 DEBUG: Transitioning to form mode");
      // ✅ FIX: Ensure originalButtonRect exists for mobile positioning
      if (!this.originalButtonRect) {
        this.originalButtonRect = { ...rect, right: rect.right, bottom: rect.bottom };
      }

      this.container.style.display = "block";
      this.container.style.gap = "";
      this.container.style.alignItems = "";
      this.container.style.justifyContent = "";
      this.container.style.flexDirection = "";

      let targetWidth, targetHeight, targetTop, targetPadding;

      if (isMobile) {
        // Mobile: full-width sheet on left-anchored (reader). On right-anchored
        // (home/user) keep the historical right-edge anchoring.
        targetWidth = isLeftAnchored
          ? `${window.innerWidth - 30}px`
          : `${this.originalButtonRect.right - 15}px`;
        targetHeight = "calc(100vh - 100px)";
        targetTop = "50px";
        targetPadding = "15px";
        this.container.style.maxWidth = targetWidth;
      } else {
        // Desktop: 400px wide. On left-anchored (reader) dock to top of viewport
        // so the form doesn't run off-screen below the logo nav menu; on
        // right-anchored (home/user) keep the existing "just below the button"
        // placement that visually connects to the + at the top-right.
        targetWidth = "400px";
        targetHeight = "80vh";
        targetTop = isLeftAnchored ? "50px" : `${this.originalButtonRect.bottom + 8}px`;
        targetPadding = "0";
      }

      // Apply the new styles to trigger the transition.
      console.log("🔥 DEBUG: Applying form styles", { targetWidth, targetHeight, targetTop, targetPadding });
      requestAnimationFrame(() => {
        this.container.style.width = targetWidth;
        this.container.style.height = targetHeight;
        this.container.style.top = targetTop;
        this.container.style.padding = targetPadding;

        console.log("🔥 DEBUG: Form styles applied", {
          actualWidth: this.container.style.width,
          actualHeight: this.container.style.height,
          actualTop: this.container.style.top,
          display: this.container.style.display,
          opacity: this.container.style.opacity,
          visibility: this.container.style.visibility
        });

        // Clean up any previous animation state before setting new listeners
        this.resetAnimationState();
        this.isAnimating = true; // Set it back after reset

        // Store the handler so we can remove it if needed
        this.transitionEndHandler = () => {
          this.resetAnimationState();
        };
        this.container.addEventListener("transitionend", this.transitionEndHandler, { once: true });

        // Fallback timeout in case transitionend doesn't fire (mobile browser issue)
        this.animationTimeout = setTimeout(() => {
          if (this.isAnimating) {
            this.resetAnimationState();
          }
        }, 500);
      });
      return;
    }

    // This logic handles the very FIRST opening of the container.
    if (!this.isOpen) {
      console.log("🔥 DEBUG: Opening container for first time in mode:", mode);

      // ✅ Activate overlay FIRST to mask button background during rotation
      if (this.overlay) {
        // Disable transition temporarily for instant appearance
        this.overlay.style.transition = "none";
        this.overlay.classList.add("active");
        this.overlay.style.display = "block";
        this.overlay.style.opacity = "0.5";

        // Re-enable transition after paint (for future animations)
        requestAnimationFrame(() => {
          this.overlay.style.transition = "";
        });
      }

      // Now start icon rotation (will be masked by darkening overlay)
      this.button.querySelector(".icon")?.classList.add("tilted");

      if (!this.originalButtonRect) {
        this.originalButtonRect = { ...rect, right: rect.right, bottom: rect.bottom };
      }

      // ✅ FIX: If opening directly in form mode, skip the buttons layout
      if (mode === "form") {
        console.log("🔥 DEBUG: Opening directly in form mode");

        // Set up the container for form display - start invisible then fade in
        this.container.style.visibility = "visible";
        this.container.style.opacity = "0";
        this.container.style.display = "block";

        // Apply form-specific positioning immediately
        let targetWidth, targetHeight, targetTop, targetPadding;
        if (isMobile) {
          targetWidth = isLeftAnchored
            ? `${window.innerWidth - 30}px`
            : `${this.originalButtonRect.right - 15}px`;
          targetHeight = "calc(100vh - 100px)";
          targetTop = "50px";
          targetPadding = "15px";
          this.container.style.left = "15px";
          this.container.style.right = "";
          this.container.style.maxWidth = targetWidth;
        } else {
          targetWidth = "400px";
          targetHeight = "80vh";
          targetTop = isLeftAnchored ? "50px" : `${this.originalButtonRect.bottom + 8}px`;
          targetPadding = "0";
          if (isLeftAnchored) {
            this.container.style.left = "50px";
            this.container.style.right = "";
          } else {
            this.container.style.right = `${window.innerWidth - this.originalButtonRect.right}px`;
            this.container.style.left = "";
          }
        }

        this.container.style.width = targetWidth;
        this.container.style.height = targetHeight;
        this.container.style.top = targetTop;
        this.container.style.padding = targetPadding;

        // Fade in after positioning is set, synced with button rotation (0.3s)
        requestAnimationFrame(() => {
          this.container.style.opacity = "1";
        });

        console.log("🔥 DEBUG: Direct form mode styles applied", {
          width: targetWidth, height: targetHeight, top: targetTop, padding: targetPadding
        });

      } else {
        // Original buttons mode layout - start invisible then fade in
        this.container.style.top = `${rect.bottom + 8}px`;
        if (isLeftAnchored) {
          this.container.style.left = `${rect.left}px`;
          this.container.style.right = "";
        } else {
          this.container.style.right = `${window.innerWidth - rect.right}px`;
          this.container.style.left = "";
        }
        this.container.style.visibility = "visible";
        this.container.style.opacity = "0";
        this.container.style.width = "160px";
        this.container.style.height = "auto";
        this.container.style.padding = "20px";
        this.container.style.display = "block";

        // Fade in after positioning is set, synced with button rotation (0.3s)
        requestAnimationFrame(() => {
          this.container.style.opacity = "1";
        });
      }

      this.isOpen = true;
      (window as any).uiState?.setActiveContainer(this.container.id);

      // Clean up any previous animation state before setting new listeners
      this.resetAnimationState();
      this.isAnimating = true; // Set it back after reset

      // Store the handler so we can remove it if needed
      this.transitionEndHandler = () => {
        this.resetAnimationState();
      };
      this.container.addEventListener("transitionend", this.transitionEndHandler, { once: true });

      // Fallback timeout in case transitionend doesn't fire (mobile browser issue)
      this.animationTimeout = setTimeout(() => {
        if (this.isAnimating) {
          this.resetAnimationState();
        }
      }, 500);
    }
  }

  closeContainer() {
    // A close request must never be silently dropped. If an animation is in
    // flight, decide by TYPE:
    //   - an OPEN animation (or a stuck one with no pending timeout) is
    //     interrupted so the close can take over — this is what makes a quick
    //     overlay click reliably dismiss the form instead of no-opping during
    //     the ~500ms open animation window;
    //   - a CLOSE already running is left to finish (avoid restarting it).
    if (this.isAnimating) {
      if (this.animationType === "close" && this.animationTimeout) {
        return; // already closing — let it complete
      }
      console.warn("⚠️ Interrupting in-flight open animation to close", { animationType: this.animationType });
      this.resetAnimationState();
    }

    this.isAnimating = true;
    this.animationType = "close";

    // 🔥 MOBILE DEBUG: Log when and why container is closing
    verbose.init('closeContainer called', 'newBookButton.js');

    // Don't close if we recently clicked an external link (mobile protection)
    if (this.recentExternalLinkClick) {
      verbose.init('Preventing container close due to recent external link click', 'newBookButton.js');
      this.isAnimating = false;
      this.recentExternalLinkClick = false;
      return;
    }

    verbose.init('Clearing original button rect', 'newBookButton.js');
    this.originalButtonRect = null; // Clear so it gets recalculated next time

    // ✅ CLEANUP: Remove resize listener when form is closed
    this.cleanupResizeListener();

    this.saveFormData();

    // Remove tilt from icon, if applicable
    const icon = this.button.querySelector(".icon");
    if (icon) {
      icon.classList.remove("tilted");
    }

    // Start the closing animation. Only animate width/height/opacity/padding
    // toward 0 — leave left/right/top alone. Clearing those mid-animation
    // makes the container glide off toward the layout origin (top-left)
    // because the CSS transition interpolates `50px → auto` as `50px → 0`.
    // Positioning is reset in the transitionend handler instead.
    this.container.style.padding = "0";
    this.container.style.width = "0";
    this.container.style.height = "0";
    this.container.style.opacity = "0";

    // Deactivate the overlay
    if (this.overlay) {
      this.overlay.classList.remove("active");
      this.overlay.style.opacity = "0";
    }

    // Set state and finish the animation
    this.isOpen = false;
    if ((window as any).uiState) {
      (window as any).uiState.setActiveContainer("main-content");
    } else {
      (window as any).activeContainer = "main-content";
    }

    // Clean up any previous animation state before setting new listeners
    this.resetAnimationState();
    this.isAnimating = true; // Set it back after reset

    // Store the handler so we can remove it if needed
    this.transitionEndHandler = () => {
      this.container.classList.add("hidden");
      this.container.style.display = "none";

      // Now safe to clear positioning — the container is hidden, so resetting
      // these styles can't produce a visible jump on the next paint.
      this.container.style.left = "";
      this.container.style.right = "";
      this.container.style.top = "";
      this.container.style.transform = "";

      this.resetAnimationState();

      if (this.overlay) {
        this.overlay.style.display = "none";
      }

      if (this.originalContent &&
        this.container.innerHTML !== this.originalContent) {
        this.container.innerHTML = this.originalContent;
        this.setupButtonListeners();
      }
    };

    this.container.addEventListener("transitionend", this.transitionEndHandler, { once: true });

    // Fallback timeout in case transitionend doesn't fire (mobile browser issue)
    this.animationTimeout = setTimeout(() => {
      if (this.isAnimating) {
        // Run the same cleanup logic
        this.container.classList.add("hidden");
        this.container.style.display = "none";

        this.container.style.left = "";
        this.container.style.right = "";
        this.container.style.top = "";
        this.container.style.transform = "";

        this.resetAnimationState();

        if (this.overlay) {
          this.overlay.style.display = "none";
        }

        if (this.originalContent &&
          this.container.innerHTML !== this.originalContent) {
          this.container.innerHTML = this.originalContent;
          this.setupButtonListeners();
        }
      }
    }, 500);
  }

  saveFormData() {
    const form = byId('cite-form');
    if (!form) return;

    const data: any = {};

    // Get all form inputs except file inputs
    const inputs = form.querySelectorAll('input:not([type="file"]), textarea, select');
    inputs.forEach((input: any) => {
      if (input.type === 'radio') {
        if (input.checked) {
          data[input.name] = input.value;
        }
      } else if (input.type === 'checkbox') {
        data[input.name] = input.checked;
      } else {
        data[input.name] = input.value;
      }
    });

    // Handle file input separately - just save the filename for reference
    const fileInput = byId('markdown_file');
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      data.selectedFileName = fileInput.files[0].name;
    }

    // Save to localStorage
    localStorage.setItem('newbook-form-data', JSON.stringify(data));
    console.log('Form data saved:', data);
  }

  loadFormData() {
    const savedData = localStorage.getItem('newbook-form-data');
    if (!savedData) return;

    try {
      const data = JSON.parse(savedData);
      console.log('Loading form data:', data);

      // Wait a bit for the form to be fully rendered
      setTimeout(() => {
        // Restore specific form fields by ID
        const fieldIds = ['bibtex', 'book', 'author', 'title', 'year', 'url', 'pages', 'journal', 'publisher', 'school', 'note', 'volume', 'issue', 'booktitle', 'chapter', 'editor', '_token'];

        fieldIds.forEach(fieldId => {
          const element = byId(fieldId);
          if (element && data[fieldId]) {
            element.value = data[fieldId];
          }
        });

        // Restore import mode radio (triggers mode switching via change event)
        if (data.import_mode) {
          const modeRadio = sel(`input[name="import_mode"][value="${data.import_mode}"]`);
          if (modeRadio) {
            modeRadio.checked = true;
            modeRadio.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        // Restore radio button selection
        if (data.type) {
          const radio = sel(`input[name="type"][value="${data.type}"]`);
          if (radio) {
            radio.checked = true;
            this.toggleOptionalFields(data.type);
          }
        }

        // Show a message about the previously selected file
        if (data.selectedFileName) {
          const fileInput = byId('markdown_file');
          if (fileInput) {
            // Remove any existing file note
            const existingNote = byId('file-restore-note');
            if (existingNote) {
              existingNote.remove();
            }

            // Create a new note about the previously selected file
            const fileNote = document.createElement('div');
            fileNote.id = 'file-restore-note';
            fileNote.style.fontSize = '12px';
            fileNote.style.color = '#EF8D34';
            fileNote.style.marginTop = '5px';
            fileNote.textContent = `Previously selected: ${data.selectedFileName} (please reselect)`;
            fileInput.parentNode.insertBefore(fileNote, fileInput.nextSibling);
          }
        }

        // Trigger validations after values are restored so messages appear without interaction
        try {
          const bookField = byId('book');
          const title = byId('title');
          const fileInput = byId('markdown_file');

          if (title) {
            title.dispatchEvent(new Event('input', { bubbles: true }));
            title.dispatchEvent(new Event('blur', { bubbles: true }));
          }

          if (bookField && bookField.value) {
            bookField.dispatchEvent(new Event('input', { bubbles: true }));
            bookField.dispatchEvent(new Event('blur', { bubbles: true }));
          }

          if (fileInput) {
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch (e) {
          console.warn('Unable to trigger validations after draft load', e);
        }

      }, 100);

    } catch (error) {
      console.error('Error loading form data:', error);
    }
  }

  clearSavedFormData() {
    localStorage.removeItem('newbook-form-data');
  }
}
