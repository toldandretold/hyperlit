// footnotes-citations.js - New unified system for footnotes and citations
import { book } from "./app.js";
import { openDatabase } from "./indexedDB.js";
import { ContainerManager } from "./containerManager.js";
import { handleUnifiedContentClick, initializeHyperlitManager, openHyperlitContainer, closeHyperlitContainer } from './hyperlitContainer/index.js';

// Legacy container manager - now using unified system
const refManager = new ContainerManager(
  "ref-container",   // The container to manage
  "ref-overlay",     // The overlay element
  null,              // No dedicated toggle button
  ["main-content", "nav-buttons"] // IDs to freeze when ref-container is open
);

// Export the DOM elements for backward compatibility
export const refContainer = document.getElementById("ref-container");
export const refOverlay = document.getElementById("ref-overlay");
export const isRefOpen = refManager.isOpen;

// Export the manager itself so it can be rebound after SPA transitions
export { refManager };

// Destroy function for cleanup during navigation
export function destroyRefManager() {
  if (refManager) {
    console.log('🧹 Destroying reference container manager');
    refManager.destroy();
    return true;
  }
  return false;
}

// Function to open the reference container with content (now redirects to unified system)
export function openReferenceContainer(content) {
  console.log('🔧 DEBUG: openReferenceContainer called - redirecting to unified container');
  openHyperlitContainer(content);
}

// Function to close the reference container (now redirects to unified system)
export function closeReferenceContainer() {
  closeHyperlitContainer();
}

// Main click handler for footnotes and citations (now uses unified system)
export async function handleFootnoteOrCitationClick(element) {
  try {
    // Use unified container system for all footnote/citation clicks
    await handleUnifiedContentClick(element);
  } catch (error) {
    console.error('Error handling footnote/citation click:', error);
  }
}


// Initialize click listeners
export function initializeFootnoteCitationListeners() {
  document.addEventListener('click', (event) => {
    const target = event.target;
    
    // Check if the clicked element or its parent is a footnote or citation
    if (target.tagName === 'SUP' && target.hasAttribute('fn-count-id')) {
      event.preventDefault();
      event.stopPropagation();
      handleFootnoteOrCitationClick(target);
    } else if (target.tagName === 'A' && target.classList.contains('footnote-ref')) {
      event.preventDefault();
      event.stopPropagation();
      handleFootnoteOrCitationClick(target);
    } else if (target.tagName === 'A' && target.classList.contains('in-text-citation')) {
      event.preventDefault();
      event.stopPropagation();
      handleFootnoteOrCitationClick(target);
    }
  }, true); // Use capture phase to run before other listeners
  
  console.log('✅ Footnote and citation listeners initialized');
}