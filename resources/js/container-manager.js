import { saveAnnotationToIndexedDB } from "./annotation-saver.js";
import { navigateToInternalId } from "./scrolling.js"; // Import this if needed
import { currentLazyLoader } from "./initializePage.js";

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

    // Track the original visibility state of navigation elements
     this.navElementsState = {
    navButtons: true,
    logoContainer: true,
    topRightContainer: true,
    userContainer: true  // Add this line
    };

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
        e.preventDefault(); // Add this to prevent default action
        this.toggleContainer();
      });
    }

      // Add a new event listener for link clicks within the container
      // Add a new event listener for link clicks within the container
      if (this.container) {
        this.container.addEventListener("click", (e) => {
          const link = e.target.closest("a");
          if (!link) return; // Not a link click
          
          const href = link.getAttribute("href");
          if (!href) return; // No href attribute

          // Check if this is a citation link (has hypercite in the hash)
          const isCitationLink = href.includes("#hypercite_");
          
          if (isCitationLink) {
              e.preventDefault();
              
              // Extract the hash part
              const url = new URL(href, window.location.origin);
              const hash = url.hash ? url.hash.substring(1) : null;
              
              // Close the current container
              this.closeContainer();
              
              
              if (hash) {
                  navigateToInternalId(hash, currentLazyLoader);
                }
              
              
              return;
            }
          
          // Create URL objects for comparison
          const currentUrl = new URL(window.location.href);
          let targetUrl;
          try {
            targetUrl = new URL(href, window.location.origin);
          } catch (e) {
            console.error("Invalid URL:", href);
            return;
          }
          
          // Check if this is actually an internal navigation
          const isInternalNavigation = 
            targetUrl.pathname === currentUrl.pathname || 
            href.startsWith('#') ||
            href.startsWith('/HL_');
          
          if (isInternalNavigation) {
            e.preventDefault();
            
            const isHighlightLink = href.includes("/HL_");
            const highlightMatch = href.match(/\/HL_\d+/);
            const highlightId = highlightMatch ? highlightMatch[0].substring(1) : null;
            
            const hash = targetUrl.hash ? targetUrl.hash.substring(1) : null;
            
            this.closeContainer();
            
            setTimeout(() => {
              if (isHighlightLink && highlightId) {
                if (hash) {
                  window.history.pushState(null, '', `#${hash}`);
                } else {
                  window.history.pushState(null, '', window.location.pathname);
                }
                navigateToInternalId(highlightId, currentLazyLoader);
              } else if (hash) {
                navigateToInternalId(hash, currentLazyLoader);
              } else {
                window.location.href = href;
              }
            }, 300);
          } else {
            // For external links, let them open in a new tab
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          }
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

  // Save the current visibility state of navigation elements
 saveNavElementsState() {
  const navButtons = document.getElementById("nav-buttons");
  const logoContainer = document.getElementById("logoContainer");
  const topRightContainer = document.getElementById("topRightContainer");
  const userContainer = document.getElementById("userContainer"); // Add this line
  
  if (navButtons) {
    this.navElementsState.navButtons = !navButtons.classList.contains("hidden-nav");
  }
  
  if (logoContainer) {
    this.navElementsState.logoContainer = !logoContainer.classList.contains("hidden-nav");
  }
  
  if (topRightContainer) {
    this.navElementsState.topRightContainer = !topRightContainer.classList.contains("hidden-nav");
  }
  
  // Add this block
  if (userContainer) {
    this.navElementsState.userContainer = !userContainer.classList.contains("hidden-nav");
  }
  
  console.log("Saved nav elements state:", this.navElementsState);
}
  
  // Restore navigation elements to their saved state
  restoreNavElementsState() {
  const navButtons = document.getElementById("nav-buttons");
  const logoContainer = document.getElementById("logoContainer");
  const topRightContainer = document.getElementById("topRightContainer");
  const userContainer = document.getElementById("userContainer"); // Add this line
  
  if (navButtons) {
    if (this.navElementsState.navButtons) {
      navButtons.classList.remove("hidden-nav");
    } else {
      navButtons.classList.add("hidden-nav");
    }
  }
  
  if (logoContainer) {
    if (this.navElementsState.logoContainer) {
      logoContainer.classList.remove("hidden-nav");
    } else {
      logoContainer.classList.add("hidden-nav");
    }
  }
  
  if (topRightContainer) {
    if (this.navElementsState.topRightContainer) {
      topRightContainer.classList.remove("hidden-nav");
    } else {
      topRightContainer.classList.add("hidden-nav");
    }
  }
  
  // Add this block
  if (userContainer) {
    if (this.navElementsState.userContainer) {
      userContainer.classList.remove("hidden-nav");
    } else {
      userContainer.classList.add("hidden-nav");
    }
  }
  
  console.log("Restored nav elements state:", this.navElementsState);
}

  updateState() {
  console.log("updateState: isOpen =", this.isOpen, 
            "container.id =", this.container.id);
  if (this.isOpen) {
    console.log(`Opening ${this.container.id} container...`);
    this.container.classList.add("open");
    this.overlay.classList.add("active");

    // Freeze all background elements specified
    this.frozenElements.forEach((el) => this.freezeElement(el));

    // If we're opening the TOC or Source, hide nav-buttons, logoContainer, and topRightContainer
    if (this.container.id === "toc-container" || 
        this.container.id === "source-container") {
      // Save the current state before modifying
      this.saveNavElementsState();
      
      const navButtons = document.getElementById("nav-buttons");
      const logoContainer = document.getElementById("logoContainer");
      const topRightContainer = document.getElementById("topRightContainer");
      const userContainer = document.getElementById("userContainer"); // Add this line

      if (navButtons) {
        navButtons.classList.add("hidden-nav");
      }
      if (logoContainer) {
        logoContainer.classList.add("hidden-nav");
      }
      if (topRightContainer) {
        topRightContainer.classList.add("hidden-nav");
      }
      if (userContainer) { // Add this block
        userContainer.classList.add("hidden-nav");
      }
    }
  } else {
    console.log(`Closing ${this.container.id} container...`);
    this.container.classList.remove("open");
    this.overlay.classList.remove("active");

    // Unfreeze background elements when closing
    this.frozenElements.forEach((el) => this.unfreezeElement(el));

    // If we're closing the TOC or Source, restore the navigation elements to their original state
    if (this.container.id === "toc-container" || 
        this.container.id === "source-container") {
      this.restoreNavElementsState();
    }
  }
}


  /**
   * Opens the container.
   * @param {string|null} content - The inner HTML content to set.
   * @param {string|null} highlightId - (Optional) The highlight ID in case this is a highlight container.
   */
  // In ContainerManager class, modify the openContainer method:
openContainer(content = null, highlightId = null) {
  console.log("Current active container:", window.activeContainer);

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
  
  // Directly hide navigation elements if this is TOC container
  if (this.container.id === "toc-container") {
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const topRightContainer = document.getElementById("topRightContainer");
    const userContainer = document.getElementById("userContainer"); 
    
    // Save state before hiding
    this.saveNavElementsState();
    
    if (navButtons) navButtons.classList.add("hidden-nav");
    if (logoContainer) logoContainer.classList.add("hidden-nav");
    if (topRightContainer) topRightContainer.classList.add("hidden-nav");
    if (userContainer) userContainer.classList.add("hidden-nav"); 
  }
  
  // Update state after making changes
  this.updateState();

  // Optionally focus the container.
  this.container.focus();
}

// Similarly, modify the closeContainer method:
closeContainer() {
  console.log("Current active container:", window.activeContainer);
  // If this is the highlight container and a highlightId exists, force-save
  if (this.container.id === "highlight-container" && this.highlightId) {
    // ... existing highlight saving code ...
  } 

  // Hide the container by setting CSS visibility
  this.container.style.visibility = "hidden";

  this.isOpen = false;
  window.activeContainer = "main-content";
  
  // Directly show navigation elements if this is TOC container
  if (this.container.id === "toc-container") {
    const navButtons = document.getElementById("nav-buttons");
    const logoContainer = document.getElementById("logoContainer");
    const topRightContainer = document.getElementById("topRightContainer");
    const userContainer = document.getElementById("userContainer");
    
    if (navButtons) navButtons.classList.remove("hidden-nav");
    if (logoContainer) logoContainer.classList.remove("hidden-nav");
    if (topRightContainer) topRightContainer.classList.remove("hidden-nav");
    if (userContainer) userContainer.classList.remove("hidden-nav");
  }
  
  // Update state
  this.updateState();

  // Remove classes as before.
  this.container.classList.remove("open");
  this.container.classList.add("hidden");

  // Reset visibility for next time.
  this.container.style.visibility = "";
  this.cleanupURL();
}

  // New method to clean up the URL
  cleanupURL() {
    console.log("cleanupURL called");
    
    // Get the current URL parts
    const currentPath = window.location.pathname;
    const currentURL = window.location.href;
    
    console.log("Current URL:", currentURL);
    console.log("Current path:", currentPath);
    
    // Extract just the book name from the path
    // Assuming URL structure is like: /book/suffix1/suffix2
    const pathParts = currentPath.split('/').filter(part => part.length > 0);
    
    if (pathParts.length > 0) {
      // The first part should be the book name
      const bookName = pathParts[0];
      const newPath = '/' + bookName;
      
      console.log("Book name:", bookName);
      console.log("New path will be:", newPath);
      
      // Update the URL to just /book (removing all suffixes and hash)
      window.history.pushState({}, document.title, newPath);
      console.log(`URL cleaned up: ${newPath}`);
    } else {
      console.log("Could not determine book name from path:", currentPath);
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


