// Export the NavButtons class
export default class NavButtons {
  /**
   * Options:
   * - elementIds: An array of IDs or selectors of elements to toggle (default ["nav-buttons"]).
   * - tapThreshold: Maximum movement in pixels to consider an event a tap (default 10).
   */
  constructor(options = {}) {
    this.elementIds = options.elementIds || ["nav-buttons"];
    this.tapThreshold = options.tapThreshold || 10;
    this.elements = this.elementIds.map((id) =>
      document.getElementById(id)
    );

    // Check if all elements exist
    this.elements.forEach((element, index) => {
      if (!element) {
        throw new Error(
          `Element with id "${this.elementIds[index]}" not found.`
        );
      }
    });

    this.startX = 0;
    this.startY = 0;

    // Detect if the device has touch support.
    this.isTouchDevice =
      "ontouchstart" in window || navigator.maxTouchPoints > 0;

    // Bind event handlers.
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.updatePosition = this.updatePosition.bind(this);
    this.handleResize = this.handleResize.bind(this);

    this.resizeDebounceTimeout = null;
  }

  /**
   * Initialize event listeners.
   */
  init() {
    if (this.isTouchDevice) {
      if (window.PointerEvent) {
        document.addEventListener("pointerdown", this.handlePointerDown);
        document.addEventListener("pointerup", this.handlePointerUp);
      } else {
        document.addEventListener("touchstart", this.handlePointerDown);
        document.addEventListener("touchend", this.handlePointerUp);
      }
    } else {
      document.addEventListener("click", this.handleClick);
    }

    // Update nav-buttons position initially and on window resize.
    this.updatePosition();
    window.addEventListener("resize", this.handleResize);
  }

  /**
   * Remove event listeners.
   */ 
  destroy() {
    if (this.isTouchDevice) {
      if (window.PointerEvent) {
        document.removeEventListener("pointerdown", this.handlePointerDown);
        document.removeEventListener("pointerup", this.handlePointerUp);
      } else {
        document.removeEventListener("touchstart", this.handlePointerDown);
        document.removeEventListener("touchend", this.handlePointerUp);
      }
    } else {
      document.removeEventListener("click", this.handleClick);
    }
    window.removeEventListener("resize", this.handleResize);
  }

  /**
   * Checks if an event should be ignored because it originates
   * from a sup.note or any interactive element.
   */

  shouldIgnoreEvent(event) {
    // Check if any container is active
    const activeContainer = window.uiState?.activeContainer || window.activeContainer;
    if (activeContainer && activeContainer !== "main-content") {
      console.log(`NavButtons: Ignoring click because ${activeContainer} is active`);
      return true;
    }
    
    // Also check if the event is from an interactive element
    return (
      event.target.closest("sup.note") ||
      event.target.closest("button, a") ||
      event.target.closest("mark") ||
      event.target.closest(".open") ||
      event.target.closest(".active")
    );
  }

  /**
   * Record the starting pointer/touch coordinates.
   */
  handlePointerDown(event) {
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    this.startX = event.clientX;
    this.startY = event.clientY;
  }

  /**
   * On pointer/touch up, check if the movement is small enough to be considered a tap.
   */
  handlePointerUp(event) {
    const mainContent = document.querySelector(".main-content");
    if (!mainContent || mainContent.offsetParent === null) {
      return;
    }
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    const deltaX = Math.abs(event.clientX - this.startX);
    const deltaY = Math.abs(event.clientY - this.startY);
    if (deltaX < this.tapThreshold && deltaY < this.tapThreshold) {
      this.elements.forEach((element) => {
        element.classList.toggle("hidden-nav");
      });
    }
  }

  /**
   * On click (desktop), toggle the navigation container.
   */
  handleClick(event) {
    const mainContent = document.querySelector(".main-content");
    if (!mainContent || mainContent.offsetParent === null) {
      return;
    }
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    this.elements.forEach((element) => {
      element.classList.toggle("hidden-nav");
    });
  }

  /**
   * Update the position of nav-buttons relative to the .main-content and viewport.
   */
  updatePosition() {
      window.requestAnimationFrame(() => {
        const mainContent = document.querySelector(".main-content");
        if (!mainContent) {
          return;
        }
        const windowWidth = window.innerWidth;
        // Adjust the main-content width—if needed you can subtract any extra padding;
        // here we use 20 (adjust as needed).
        const computedMainWidth = mainContent.offsetWidth - 20;
        const margin = (windowWidth - computedMainWidth) / 2;

        // Desired minimum distance from the main-content's edge.
        const minDistance = 20;
        let newRight, newLeft;
        if (margin >= 2 * minDistance) {
          newRight = margin - minDistance;
          newLeft = margin - minDistance;
        } else {
          newRight = margin / 2;
          newLeft = margin / 2;
        }

        // Iterate over each element and update its offset appropriately based on its ID.
        this.elements.forEach((element) => {
          if (element.id === "nav-buttons" || element.id === "topRightContainer") {
            element.style.right = `${newRight}px`;
          } else if (element.id === "logoContainer" || element.id === "userButtonContainer") {
            element.style.left = `${newLeft}px`;
          }
        });
      });
    }


  /**
   * Handle resize event:
   * - Temporarily disable the right transition.
   * - Update the position.
   * - Remove the temporary class after the resize stops.
   */
  handleResize() {
    this.elements.forEach((element) => {
      element.classList.add("disable-right-transition");
    });
    this.updatePosition();
    clearTimeout(this.resizeDebounceTimeout);
    this.resizeDebounceTimeout = setTimeout(() => {
      this.elements.forEach((element) => {
        element.classList.remove("disable-right-transition");
      });
    }, 100); // Adjust the debounce delay as needed.
  }
}
