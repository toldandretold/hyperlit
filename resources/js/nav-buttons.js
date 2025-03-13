// Export the NavButtons class
export default class NavButtons {
  /**
   * Options:
   * - elementId: The ID of the element that contains the buttons (default "nav-buttons").
   * - tapThreshold: Maximum movement in pixels to consider an event a tap (default 10).
   */
  constructor(options = {}) {
    this.elementId = options.elementId || "nav-buttons";
    this.tapThreshold = options.tapThreshold || 10;
    this.navButtons = document.getElementById(this.elementId);

    if (!this.navButtons) {
      throw new Error(`Element with id "${this.elementId}" not found.`);
    }

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
      event.target.closest("button, a") || event.target.closest("mark")
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
    // First, make sure that the main-content is active.
    if (window.activeContainer !== "main-content") {
      return;
    }
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    const deltaX = Math.abs(event.clientX - this.startX);
    const deltaY = Math.abs(event.clientY - this.startY);
    if (deltaX < this.tapThreshold && deltaY < this.tapThreshold) {
      this.navButtons.classList.toggle("hidden-nav");
    }
  }

  /**
   * On click (desktop), toggle the navigation container,
   * but ignore clicks from interactive elements or note markers.
   */
  handleClick(event) {
    // Only allow toggling if main-content is active.
    if (window.activeContainer !== "main-content") {
      return;
    }
    if (this.shouldIgnoreEvent(event)) {
      return;
    }
    this.navButtons.classList.toggle("hidden-nav");
  }
}
