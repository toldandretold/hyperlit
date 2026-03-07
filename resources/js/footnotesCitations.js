// footnotes-citations.js - New unified system for footnotes and citations
import { handleUnifiedContentClick, initializeHyperlitManager, openHyperlitContainer, closeHyperlitContainer } from './hyperlitContainer/index.js';
import { log, verbose } from './utilities/logger.js';
import { isActivelyScrollingForLinkBlock } from './scrolling.js';

// Function to open the reference container with content (now redirects to unified system)
export function openReferenceContainer(content) {
  console.log('🔧 DEBUG: openReferenceContainer called - redirecting to unified container');
  openHyperlitContainer(content);
}

// Function to close the reference container (now redirects to unified system)
export async function closeReferenceContainer() {
  await closeHyperlitContainer();
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


// Store the handler reference so we can remove it
let footnoteClickHandler = null;

// Initialize click listeners
export function initializeFootnoteCitationListeners() {
  // Remove existing listeners if they exist (prevent duplicates)
  if (footnoteClickHandler) {
    document.removeEventListener('click', footnoteClickHandler, true);
    verbose.init('Removed existing footnote/citation click listener', '/footnotesCitations.js');
  }

  // Create the click handler
  footnoteClickHandler = (event) => {
    // Prevent footnote clicks during active scrolling.
    // Same guard used by lazyLoaderFactory.js for <a> link clicks.
    // Without this, a touch-scroll over a sup[fn-count-id] fires a synthetic
    // click at touchend, opening a phantom footnote container.
    if (isActivelyScrollingForLinkBlock()) {
      return;
    }

    const target = event.target;

    // Check if the clicked element or its parent is a footnote or citation
    // New format: <sup fn-count-id="1" id="..." class="footnote-ref">1</sup>
    // Old format: <sup fn-count-id="1" id="..."><a class="footnote-ref" href="#...">1</a></sup>
    if (target.tagName === 'SUP' && target.hasAttribute('fn-count-id')) {
      event.preventDefault();
      event.stopPropagation();

      // 🔍 DEBUG: Add IMMEDIATE keydown listener to see when events start
      const clickTime = performance.now();
      console.log(`🔍 FOOTNOTE CLICK at ${clickTime.toFixed(0)}ms - adding immediate keydown listener`);
      const immediateKeyHandler = (e) => {
        console.log(`🔍 IMMEDIATE KEYDOWN at ${performance.now().toFixed(0)}ms (${(performance.now() - clickTime).toFixed(0)}ms after click) - key: ${e.key}`);
        document.removeEventListener('keydown', immediateKeyHandler, true);
      };
      document.addEventListener('keydown', immediateKeyHandler, true);

      handleFootnoteOrCitationClick(target);
    } else if (target.tagName === 'A' && target.classList.contains('footnote-ref')) {
      event.preventDefault();
      event.stopPropagation();

      // 🔍 DEBUG: Add IMMEDIATE keydown listener to see when events start
      const clickTime = performance.now();
      console.log(`🔍 FOOTNOTE CLICK at ${clickTime.toFixed(0)}ms - adding immediate keydown listener`);
      const immediateKeyHandler = (e) => {
        console.log(`🔍 IMMEDIATE KEYDOWN at ${performance.now().toFixed(0)}ms (${(performance.now() - clickTime).toFixed(0)}ms after click) - key: ${e.key}`);
        document.removeEventListener('keydown', immediateKeyHandler, true);
      };
      document.addEventListener('keydown', immediateKeyHandler, true);

      handleFootnoteOrCitationClick(target);
    } else if (target.tagName === 'A' && target.classList.contains('in-text-citation')) {
      event.preventDefault();
      event.stopPropagation();
      handleFootnoteOrCitationClick(target);
    } else if (target.tagName === 'A' && target.classList.contains('citation-ref')) {
      // New author-date citation format: (Author <a class="citation-ref" id="Ref...">Year</a>)
      event.preventDefault();
      event.stopPropagation();
      handleFootnoteOrCitationClick(target);
    } else if (target.tagName === 'A') {
      // Check if this is a footnote link inside a sup (old format without footnote-ref class)
      const parentSup = target.closest('sup[fn-count-id]');
      if (parentSup) {
        event.preventDefault();
        event.stopPropagation();
        handleFootnoteOrCitationClick(parentSup);
      }
    }
  };

  // Add new listener
  document.addEventListener('click', footnoteClickHandler, true); // Use capture phase

  log.init('Footnote and citation listeners initialized', '/footnotesCitations.js');
}

/**
 * Destroy footnote/citation click listeners
 * Used by buttonRegistry for proper cleanup on SPA transitions
 */
export function destroyFootnoteCitationListeners() {
  if (footnoteClickHandler) {
    document.removeEventListener('click', footnoteClickHandler, true);
    footnoteClickHandler = null;
    verbose.init('Footnote/citation listeners destroyed', '/footnotesCitations.js');
  }
}