import { saveAnnotationToIndexedDB } from "./annotation-saver.js";

export class ContainerManager {
  constructor(containerId, overlayId, buttonId = null, frozenContainerIds = []) {
    this.container = document.getElementById(containerId);
    this.overlay = document.getElementById(overlayId);
    this.button = buttonId ? document.getElementById(buttonId) : null;
    this.isOpen = false;

    // Store the initial content of the container (e.g., TOC content)
    this.initialContent = this.container ? this.container.innerHTML : null;

    // In case this is a highlight container, store the current highlightId.
    this.highlightId = null;

    // Get background elements (like main-content and nav-buttons) to freeze when open.
    this.frozenElements = frozenContainerIds.map((id) =>
      document.getElementById(id)
    );

    // Set up overlay click handler
    if (this.overlay) {
      this.overlay.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (this.isOpen) {
          this.closeContainer();
        }
      });
    }

    // Set up button click handler if a button was provided
    if (this.button) {
      this.button.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleContainer();
      });
    }
  }

  // Helper method to freeze an element:
  freezeElement(el) {
    if (el) {
      // Save current scroll position
      el.dataset.scrollPos = el.scrollTop;
      // Instead of adding a class, you could directly apply styles
      el.style.pointerEvents = "none";
      el.style.overflow = "hidden";
    }
  }

  // Helper method to unfreeze an element:
  unfreezeElement(el) {
    if (el) {
      el.style.pointerEvents = "";
      el.style.overflow = "";
      // Restore the scroll position if it was saved
      if (el.dataset.scrollPos) {
        el.scrollTop = el.dataset.scrollPos;
        delete el.dataset.scrollPos;
      }
    }
  }

  updateState() {
    if (this.isOpen) {
      console.log(`Opening ${this.container.id} container...`);
      this.container.classList.add("open");
      this.overlay.classList.add("active");

      // Freeze all background elements specified
      this.frozenElements.forEach((el) => this.freezeElement(el));

      // If we're opening the TOC, hide nav-buttons and logoContainer
      if (this.container.id === "toc-container") {
        const navButtons = document.getElementById("nav-buttons");
        const logoContainer = document.getElementById("logoContainer");

        if (navButtons) {
          navButtons.classList.add("hidden-nav");
        }
        if (logoContainer) {
          logoContainer.classList.add("hidden-nav");
        }
      }
    } else {
      console.log(`Closing ${this.container.id} container...`);
      this.container.classList.remove("open");
      this.overlay.classList.remove("active");

      // Unfreeze background elements when closing
      this.frozenElements.forEach((el) => this.unfreezeElement(el));

      // If we're closing the TOC, remove the hidden class on nav-buttons and logoContainer
      if (this.container.id === "toc-container") {
        const navButtons = document.getElementById("nav-buttons");
        const logoContainer = document.getElementById("logoContainer");

        if (navButtons) {
          navButtons.classList.remove("hidden-nav");
        }
        if (logoContainer) {
          logoContainer.classList.remove("hidden-nav");
        }
      }
    }
  }

  /**
   * Opens the container.
   * @param {string|null} content - The inner HTML content to set.
   * @param {string|null} highlightId - (Optional) The highlight ID in case this is a highlight container.
   */
  openContainer(content = null, highlightId = null) {
    if (content && this.container) {
      console.log(`Opening container ${this.container.id} with content:`, content);
      this.container.innerHTML = content;
    } else if (this.initialContent && this.container) {
      // Restore the initial content if no new content is provided
      this.container.innerHTML = this.initialContent;
    }
    // If a highlightId is provided, store it.
    if (highlightId) {
      this.highlightId = highlightId;
    }
    // Ensure the container is visible.
    this.container.classList.remove("hidden");
    this.container.classList.add("open");

    this.isOpen = true;
    window.activeContainer = this.container.id;
    this.updateState();

    // Optionally focus the container.
    this.container.focus();
  }

  /**
   * Closes the container and, if it's the highlight-container, forces a save.
   */
  closeContainer() {
    // If this is the highlight container and a highlightId exists, force-save
    if (this.container.id === "highlight-container" && this.highlightId) {
      // Get the editable annotation element and force blur.
      const annotationEl = this.container.querySelector(".annotation");
      if (annotationEl) {
        annotationEl.blur();
      }
      // Instead of reading innerHTML, rely on the stored value.
      const annotationHTML = this.container.dataset.lastAnnotation || "";
      console.log("Forcing save on close. Stored annotation HTML:", annotationHTML);

      // Use requestAnimationFrame to force the next frame delay.
      requestAnimationFrame(() => {
        saveAnnotationToIndexedDB(this.highlightId, annotationHTML)
          .then(() => {
            console.log("Annotation saved on close for highlightId:", this.highlightId);
          })
          .catch((err) => {
            console.error("Error saving annotation on close:", err);
          });
      });
    }

    // Hide the container by setting CSS visibility,
    // so the DOM remains intact for the save call.
    this.container.style.visibility = "hidden";

    this.isOpen = false;
    this.updateState();

    // Remove classes as before.
    this.container.classList.remove("open");
    this.container.classList.add("hidden");

    // Reset visibility for next time.
    this.container.style.visibility = "";

    // Reset the active container.
    window.activeContainer = "main-content";
  }

  toggleContainer() {
    if (this.isOpen) {
      this.closeContainer();
    } else {
      this.openContainer();
    }
  }
}
