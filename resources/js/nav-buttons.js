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
    this.elements = this.elementIds.map((id) => document.getElementById(id));

    // Check if all elements exist
    this.elements.forEach((element, index) => {
      if (!element) {
        throw new Error(`Element with id "${this.elementIds[index]}" not found.`);
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
  }

  /**
   * Initialize event listeners.
   * - If it's a touch device, use pointer/touch events.
   * - Otherwise (desktop/laptop/trackpad), use the click event.
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
  }

  /**
   * Checks if an event should be ignored because it originates
   * from a sup.note or any interactive element.
   */
  shouldIgnoreEvent(event) {
    return (
      event.target.closest("sup.note") ||
      event.target.closest("button, a") ||
      event.target.closest("mark")
    );
  }

  /**
   * Record the starting pointer/touch coordinates.
   */
  handlePointerDown(event) {
    // Even before tracking pointer down, check if we should ignore this event.
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    this.startX = event.clientX;
    this.startY = event.clientY;
  }

  /**
   * On pointer/touch up, determine if the movement was small enough
   * to be considered a tap and toggle the navigation container.
   * This handler ignores events that occur on interactive elements or note markers.
   */
  handlePointerUp(event) {
  // Get the main-content div
  const mainContent = document.querySelector(".main-content");

  // Check if the main-content div exists and is visible
  if (!mainContent || mainContent.offsetParent === null) {
    return; // Exit if the main-content div is not visible
  }

  // Check if the event should be ignored
  if (this.shouldIgnoreEvent(event)) {
    return;
  }

  // Calculate the movement
  const deltaX = Math.abs(event.clientX - this.startX);
  const deltaY = Math.abs(event.clientY - this.startY);

  // If the movement is small enough, toggle the hidden-nav class
  if (deltaX < this.tapThreshold && deltaY < this.tapThreshold) {
    this.elements.forEach((element) => {
      element.classList.toggle("hidden-nav");
    });
  }
}


  /**
   * On click (desktop), toggle the navigation container,
   * but ignore clicks from interactive elements or note markers.
   */
   handleClick(event) {
    // Get the main-content div
    const mainContent = document.querySelector(".main-content");

    // Check if the main-content div exists and is visible
    if (!mainContent || mainContent.offsetParent === null) {
      return; // Exit if the main-content div is not visible
    }

    // Check if the event should be ignored
    if (this.shouldIgnoreEvent(event)) {
      return;
    }

    // Toggle the hidden-nav class on all elements
    this.elements.forEach((element) => {
      element.classList.toggle("hidden-nav");
    });
  }

}
