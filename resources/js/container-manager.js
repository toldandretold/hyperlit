// container-manager.js
export class ContainerManager {
  constructor(containerId, overlayId, buttonId = null) {
    this.container = document.getElementById(containerId);
    this.overlay = document.getElementById(overlayId);
    this.button = buttonId ? document.getElementById(buttonId) : null;
    this.isOpen = false;
    
    // Set up overlay click handler
    if (this.overlay) {
      this.overlay.addEventListener("click", () => {
        if (this.isOpen) {
          this.closeContainer();
        }
      });
    }
    
    // Set up button click handler if a button was provided
    if (this.button) {
      this.button.addEventListener("click", () => {
        this.toggleContainer();
      });
    }
  }

  updateState() {
    if (this.isOpen) {
      console.log(`Opening ${this.container.id} container...`);
      this.container.classList.add("open");
      this.overlay.classList.add("active");
    } else {
      console.log(`Closing ${this.container.id} container...`);
      this.container.classList.remove("open");
      this.overlay.classList.remove("active");
    }
  }

  openContainer(content = null) {
    if (content && this.container) {
      console.log(`Opening container ${this.container.id} with content:`, content);
      this.container.innerHTML = content;
    }
    this.isOpen = true;
    this.updateState();
  }

  closeContainer() {
    this.isOpen = false;
    this.updateState();
    
    // Only clear content if this is a dynamic content container
    if (this.container.id === "ref-container" || this.container.id === "highlight-container") {
      setTimeout(() => {
        this.container.innerHTML = ""; // Clear content after animation
      }, 300); // Delay to match the slide-out animation
    }
  }
  
  toggleContainer() {
    if (this.isOpen) {
      this.closeContainer();
    } else {
      this.openContainer();
    }
  }
}
