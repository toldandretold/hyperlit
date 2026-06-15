// footnotesCitations.ts - Unified click router for footnotes and citations.
// Capture-phase listener that turns a tap on any footnote/citation marker into
// an "open the hyperlit container" call. Lives alongside the container it opens.
import { handleUnifiedContentClick, openHyperlitContainer, closeHyperlitContainer } from './index';
import { log, verbose } from '../utilities/logger.js';
import { isActivelyScrollingForLinkBlock } from '../scrolling';

// Function to open the reference container with content (now redirects to unified system)
export function openReferenceContainer(content: any): void {
  openHyperlitContainer(content);
}

// Function to close the reference container (now redirects to unified system)
export async function closeReferenceContainer(): Promise<void> {
  await closeHyperlitContainer();
}

// Main click handler for footnotes and citations (now uses unified system)
export async function handleFootnoteOrCitationClick(element: any): Promise<void> {
  try {
    // Use unified container system for all footnote/citation clicks
    await handleUnifiedContentClick(element);
  } catch (error) {
    console.error('Error handling footnote/citation click:', error);
  }
}


// Store the handler reference so we can remove it
let footnoteClickHandler: ((event: MouseEvent) => void) | null = null;

// Initialize click listeners
export function initializeFootnoteCitationListeners(): void {
  // Remove existing listeners if they exist (prevent duplicates)
  if (footnoteClickHandler) {
    document.removeEventListener('click', footnoteClickHandler, true);
    verbose.init('Removed existing footnote/citation click listener', '/hyperlitContainer/footnotesCitations.ts');
  }

  // Create the click handler
  footnoteClickHandler = (event: MouseEvent) => {
    // Prevent footnote clicks during active scrolling.
    // Same guard used by lazyLoaderFactory.js for <a> link clicks.
    // Without this, a touch-scroll over a sup[fn-count-id] fires a synthetic
    // click at touchend, opening a phantom footnote container.
    if (isActivelyScrollingForLinkBlock()) {
      return;
    }

    const target = event.target as HTMLElement;
    if (!target) return;

    // Check if the clicked element or its parent is a footnote or citation
    // New format: <sup fn-count-id="1" id="..." class="footnote-ref">1</sup>
    // Old format: <sup fn-count-id="1" id="..."><a class="footnote-ref" href="#...">1</a></sup>
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

  log.init('Footnote and citation listeners initialized', '/hyperlitContainer/footnotesCitations.ts');
}

/**
 * Destroy footnote/citation click listeners
 * Used by buttonRegistry for proper cleanup on SPA transitions
 */
export function destroyFootnoteCitationListeners(): void {
  if (footnoteClickHandler) {
    document.removeEventListener('click', footnoteClickHandler, true);
    footnoteClickHandler = null;
    verbose.init('Footnote/citation listeners destroyed', '/hyperlitContainer/footnotesCitations.ts');
  }
}
