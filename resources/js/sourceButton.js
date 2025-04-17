import { ContainerManager } from "./container-manager.js";

export class SourceContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    
    this.setupSourceContainerStyles();
    this.isAnimating = false;
  }
  
  setupSourceContainerStyles() {
    const container = this.container;
    if (!container) return;
    
    // Set initial styles for the container when closed
    container.style.position = "fixed";
    container.style.top = "16px";
    container.style.right = "16px";
    container.style.width = "0";
    container.style.height = "0";
    container.style.overflow = "hidden";
    container.style.transition = "width 0.4s ease-out, height 0.4s ease-out";
    container.style.zIndex = "1000";
    container.style.backgroundColor = "#221F20";
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
    container.style.borderRadius = "1em 1em";
  }
  
  openContainer(content = null, highlightId = null) {
    if (this.isAnimating) return;
    this.isAnimating = true;
    
    console.log("Opening source container");
    
    // Set content if provided or use initial content
    if (content && this.container) {
      this.container.innerHTML = content;
    } else if (this.initialContent && this.container) {
      this.container.innerHTML = this.initialContent;
    }
    
    // Make container visible but with 0 dimensions
    this.container.classList.remove("hidden");
    this.container.style.visibility = "visible";
    this.container.style.display = "block";
    
    // Get viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Calculate target dimensions
    const targetWidth = viewportWidth * 0.8;
    const targetHeight = viewportHeight * 0.9;
    
    // Start the animation
    requestAnimationFrame(() => {
      this.container.style.width = `${targetWidth}px`;
      this.container.style.height = `${targetHeight}px`;
      
      // Freeze background elements
      this.frozenElements.forEach((el) => this.freezeElement(el));
      
      // Activate overlay - IMPORTANT: Make sure it's visible
      if (this.overlay) {
        console.log("Activating overlay");
        this.overlay.classList.add("active");
        this.overlay.style.display = "block";
        this.overlay.style.opacity = "1";
      }
      
      // Hide navigation elements
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const topRightContainer = document.getElementById("topRightContainer");
      
      if (navButtons) navButtons.classList.add("hidden-nav");
      if (logoContainer) logoContainer.classList.add("hidden-nav");
      if (topRightContainer) topRightContainer.classList.add("hidden-nav");
      
      // CORRECTED: Set state properly when opening
      this.isOpen = true;
      if (window.uiState) {
        window.uiState.setActiveContainer(this.container.id);
      } else {
        window.activeContainer = this.container.id;
      }
      
      // Complete animation
      this.container.addEventListener(
        "transitionend",
        () => {
          this.isAnimating = false;
          console.log("Source container open animation complete");
        },
        { once: true }
      );
    });
  }

  closeContainer() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    
    console.log("Closing source container");
    
    // Start the closing animation
    this.container.style.width = "0";
    this.container.style.height = "0";
    
    // Unfreeze background elements
    this.frozenElements.forEach((el) => this.unfreezeElement(el));
    
    // Deactivate overlay - IMPORTANT: Make sure it's hidden
    if (this.overlay) {
      console.log("Deactivating overlay");
      this.overlay.classList.remove("active");
      // Force overlay to be hidden with inline styles
      this.overlay.style.display = "none";
      this.overlay.style.opacity = "0";
    }
    
    // Show navigation elements
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const topRightContainer = document.getElementById("topRightContainer");
    
    if (navButtons) navButtons.classList.remove("hidden-nav");
    if (logoContainer) logoContainer.classList.remove("hidden-nav");
    if (topRightContainer) topRightContainer.classList.remove("hidden-nav");
    
    // Set state
    this.isOpen = false;
    if (window.uiState) {
      window.uiState.setActiveContainer("main-content");
    } else {
      window.activeContainer = "main-content";
    }
    
    // Complete animation
    this.container.addEventListener(
      "transitionend",
      () => {
        // Additional cleanup after animation completes
        this.container.classList.add("hidden");
        this.isAnimating = false;
        console.log("Source container close animation complete");
        
        // Double-check overlay is hidden
        if (this.overlay) {
          this.overlay.style.display = "none";
        }
      },
      { once: true }
    );
  }
  
  toggleContainer() {
    console.log("Toggle container called, isOpen:", this.isOpen);
    if (this.isAnimating) {
      console.log("Animation in progress, ignoring toggle");
      return;
    }
    
    if (this.isOpen) {
      this.closeContainer();
    } else {
      this.openContainer();
    }
  }
}

// Initialize the source container manager
const sourceManager = new SourceContainerManager(
  "source-container",
  "ref-overlay",
  "cloudRef",
  ["main-content"]
);

// Export the manager instance for use in other files if needed
export default sourceManager;
