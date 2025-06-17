// userContainer.js
import { ContainerManager } from "./container-manager.js";

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.isAnimating = false;
    this.setupUserListeners();
  }

  setupUserListeners() {
    // Add any specific user container event listeners here
    // For example, form switching between login/register
  }

      openContainer() {
      if (this.isAnimating) return;
      this.isAnimating = true;

      this.container.classList.remove("hidden");
      this.container.classList.add("open"); // This triggers the transform: translateX(0)

      if (this.overlay) {
        this.overlay.classList.add("active");
      }

      this.isOpen = true;
      window.activeContainer = this.container.id;

      setTimeout(() => {
        this.isAnimating = false;
      }, 300);
    }

    closeContainer() {
      if (this.isAnimating) return;
      this.isAnimating = true;

      this.container.classList.remove("open"); // This triggers transform: translateX(-105%)
      this.container.classList.add("hidden");

      if (this.overlay) {
        this.overlay.classList.remove("active");
      }

      this.isOpen = false;
      window.activeContainer = "main-content";

      setTimeout(() => {
        this.isAnimating = false;
      }, 300);
    }
}

// Initialize the user container manager
const userManager = new UserContainerManager(
  "user-container",
  "user-overlay", 
  "userButton",
  ["main-content"]
);

export default userManager;