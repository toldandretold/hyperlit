// container-manager.js
export class ContainerManager {
  /**
   * @param {string} containerId - ID of the container to control.
   * @param {string} overlayId - ID of the overlay element.
   * @param {string|null} buttonId - ID of the button (optional) that toggles the container.
   * @param {Array<string>} frozenContainerIds - Array of IDs for elements that should be frozen
   *    when this container is open.
   */
  constructor(containerId, overlayId, buttonId = null, frozenContainerIds = []) {
    this.container = document.getElementById(containerId);
    this.overlay = document.getElementById(overlayId);
    this.button = buttonId ? document.getElementById(buttonId) : null;
    this.isOpen = false;

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

      // If we're opening the TOC, hide nav-buttons
      if (this.container.id === "toc-container") {
        const navButtons = document.getElementById("nav-buttons");
        if (navButtons) {
          navButtons.classList.add("hidden-nav");
        }
      }
    } else {
      console.log(`Closing ${this.container.id} container...`);
      this.container.classList.remove("open");
      this.overlay.classList.remove("active");
      
      // Unfreeze background elements when closing
      this.frozenElements.forEach((el) => this.unfreezeElement(el));
      
      // If we're closing the TOC, remove the hidden class on nav-buttons
      if (this.container.id === "toc-container") {
        const navButtons = document.getElementById("nav-buttons");
        if (navButtons) {
          navButtons.classList.remove("hidden-nav");
        }
      }
    }
  }


  openContainer(content = null) {
    if (content && this.container) {
      console.log(
        `Opening container ${this.container.id} with content:`,
        content
      );
      this.container.innerHTML = content;
    }
    this.isOpen = true;

    // Set the active container globally.
    // This allows other components (e.g., NavButtons) to know which container is active.
    window.activeContainer = this.container.id;

    this.updateState();
  }

  closeContainer() {
    this.isOpen = false;
    this.updateState();

    // Only clear content if this is a dynamic content container
    if (
      this.container.id === "ref-container" ||
      this.container.id === "highlight-container"
    ) {
      setTimeout(() => {
        this.container.innerHTML = ""; // Clear content after animation
      }, 300); // Delay to match the slide-out animation
    }

    // When closing, reset the active container.
    // Adjust this default back to whatever should be active (e.g. "main-content").
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
