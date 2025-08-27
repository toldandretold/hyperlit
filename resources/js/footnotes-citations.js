// footnotes-citations.js - New unified system for footnotes and citations
import { book } from "./app.js";
import { openDatabase } from "./cache-indexedDB.js";
import { ContainerManager } from "./container-manager.js";

// Create a container manager for references
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

// Function to open the reference container with content
export function openReferenceContainer(content) {
  // First open the container (this handles all the overlay/state management)
  refManager.openContainer();
  
  // Then insert content into the scroller div specifically
  const scroller = refContainer.querySelector('.scroller');
  if (scroller) {
    scroller.innerHTML = content;
  } else {
    // Fallback: insert directly into container if no scroller found
    refContainer.innerHTML = content;
  }
}

// Function to close the reference container
export function closeReferenceContainer() {
  refManager.closeContainer();
}

// Main click handler for footnotes and citations
export async function handleFootnoteOrCitationClick(element) {
  try {
    // Check if it's a footnote (sup with fn-count-id)
    if (element.tagName === 'SUP' && element.hasAttribute('fn-count-id')) {
      await handleFootnoteClick(element);
    }
    // Check if it's a citation (a with class in-text-citation)
    else if (element.tagName === 'A' && element.classList.contains('in-text-citation')) {
      await handleCitationClick(element);
    }
    // Check if it's a footnote link inside a sup
    else if (element.tagName === 'A' && element.classList.contains('footnote-ref')) {
      const supElement = element.closest('sup[fn-count-id]');
      if (supElement) {
        await handleFootnoteClick(supElement);
      }
    }
  } catch (error) {
    console.error('Error handling footnote/citation click:', error);
  }
}

// Handle footnote clicks
async function handleFootnoteClick(supElement) {
  const fnCountId = supElement.getAttribute('fn-count-id');
  const elementId = supElement.id;
  
  console.log('Footnote clicked:', { fnCountId, elementId, book });
  
  // Extract the footnote ID (remove the "ref" suffix if present)
  let footnoteId = elementId;
  if (footnoteId.includes('ref')) {
    footnoteId = footnoteId.replace('ref', '');
  }
  
  console.log('Looking up footnote:', footnoteId);
  
  try {
    const db = await openDatabase();
    const transaction = db.transaction(["footnotes"], "readonly");
    const store = transaction.objectStore("footnotes");
    
    // Create composite key for lookup
    const key = [book, footnoteId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (result && result.content) {
      console.log('Found footnote:', result);
      
      const htmlToDisplay = `
        <div class="footnote-content">
          <div class="footnote-header">Footnote ${fnCountId}</div>
          <div class="footnote-text">${result.content}</div>
        </div>`;
      
      openReferenceContainer(htmlToDisplay);
    } else {
      console.warn('Footnote not found:', footnoteId);
      openReferenceContainer(`<div class="error">Footnote not found: ${footnoteId}</div>`);
    }
  } catch (error) {
    console.error('Error fetching footnote:', error);
    openReferenceContainer(`<div class="error">Error loading footnote</div>`);
  }
}

// Handle citation clicks
async function handleCitationClick(linkElement) {
  const href = linkElement.getAttribute('href');
  if (!href || !href.startsWith('#')) {
    console.warn('Invalid citation href:', href);
    return;
  }
  
  const referenceId = href.substring(1); // Remove the # prefix
  
  console.log('Citation clicked:', { referenceId, book });
  
  try {
    const db = await openDatabase();
    const transaction = db.transaction(["references"], "readonly");
    const store = transaction.objectStore("references");
    
    // Create composite key for lookup
    const key = [book, referenceId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (result && result.content) {
      console.log('Found reference:', result);
      
      const htmlToDisplay = `
        <div class="citation-content">
          <div class="citation-header">Reference</div>
          <div class="citation-text">${result.content}</div>
        </div>`;
      
      openReferenceContainer(htmlToDisplay);
    } else {
      console.warn('Reference not found:', referenceId);
      openReferenceContainer(`<div class="error">Reference not found: ${referenceId}</div>`);
    }
  } catch (error) {
    console.error('Error fetching reference:', error);
    openReferenceContainer(`<div class="error">Error loading reference</div>`);
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