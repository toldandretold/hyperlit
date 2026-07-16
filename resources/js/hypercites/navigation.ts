/**
 * Hypercite Navigation & Click Routing
 *
 * Routes hypercite clicks to the unified container system and drives same-book navigation to
 * hypercite/footnote targets. (Overlapping/poly rendering is handled by the unified renderer via
 * detectHypercites → buildHyperciteContent; the old standalone poly-container path was removed.)
 */

import { navigateToInternalId } from '../scrolling/index';
import { maybePaginatorReveal } from '../scrolling/paginator';
import { waitForElementReady } from '../SPA/domReadiness';
import { getLocalStorageKey } from '../indexedDB/index';
import { highlightTargetHypercite, revealGhostIfTombstone } from './animations';
// Container actions via the DI registry leaf — no import into hyperlitContainer/* (no cycle).
import { getCurrentContainer, handleUnifiedContentClick } from '../hyperlitContainer/containerActions';
import { showTargetNotFoundToast } from '../components/toast/toast';

/**
 * Handle underline clicks - delegates to unified container system
 */
export async function handleUnderlineClick(uElement: HTMLElement, event?: Event): Promise<void> {
  console.log("🔥 handleUnderlineClick called with element:", uElement.id || uElement.tagName);

  // Use unified container system for all hypercite clicks
  console.log("🔄 Calling handleUnifiedContentClick from hyperCites.js");
  await handleUnifiedContentClick(uElement);
}

/**
 * Navigate to hypercite targets with proper sequencing and DOM readiness
 */
export async function navigateToHyperciteTarget(highlightId: string, internalId: string | null, lazyLoader: any, showOverlay = false): Promise<void> {
  try {
    console.log(`🎯 Starting hypercite navigation to highlight: ${highlightId}, internal: ${internalId}`);

    // Clear any conflicting saved scroll positions to prevent interference
    const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
    console.log(`🧹 Clearing saved scroll positions to prevent navigation interference`);
    sessionStorage.removeItem(scrollKey);

    if (internalId) {
      // Sequential navigation: highlight first, then internal ID
      console.log(`📍 Step 1: Navigating to highlight ${highlightId}`);
      // 🚀 iOS Safari fix: Properly await navigation completion
      await navigateToInternalId(highlightId, lazyLoader, showOverlay);

      // Wait for the highlight to be ready before proceeding
      await waitForElementReady(highlightId, {
        maxAttempts: 40, // 2 seconds max wait
        checkInterval: 50,
        container: lazyLoader.container
      });

      console.log(`✅ Highlight ${highlightId} ready, now navigating to internal ID ${internalId}`);

      // Small delay to let highlight open animation start
      await new Promise(resolve => setTimeout(resolve, 300));

      // Check if hypercite exists inside the opened hyperlit container
      const currentContainer = getCurrentContainer();
      const hyperciteInContainer = currentContainer?.querySelector(`#${internalId}`);
      if (hyperciteInContainer) {
        console.log(`🎯 Found hypercite ${internalId} inside hyperlit container, scrolling within container`);
        // Scroll within the hyperlit container
        const scroller = currentContainer!.querySelector('.scroller');
        if (scroller) {
          if (!maybePaginatorReveal(hyperciteInContainer)) {
            hyperciteInContainer.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
              inline: 'nearest'
            });
          }
          // Check if this is a ghost tombstone — reveal instead of highlight
          if (!revealGhostIfTombstone(internalId)) {
            highlightTargetHypercite(internalId);
          }
        }
      } else {
        console.log(`🎯 Hypercite ${internalId} not found in container, using standard navigation`);
        // Fall back to standard navigation - await it
        await navigateToInternalId(internalId, lazyLoader, showOverlay);
      }

    } else {
      // Just navigate to the highlight - await it
      console.log(`📍 Navigating directly to highlight ${highlightId}`);
      await navigateToInternalId(highlightId, lazyLoader, showOverlay);
    }

  } catch (error) {
    console.error(`❌ Error in hypercite navigation:`, error);
    // Fallback to original method if our improved method fails - await calls
    if (internalId) {
      await navigateToInternalId(highlightId, lazyLoader);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await navigateToInternalId(internalId, lazyLoader);
    } else {
      await navigateToInternalId(highlightId, lazyLoader);
    }
  }
}

/**
 * Navigate to footnote targets and open in hyperlit container
 */
export async function navigateToFootnoteTarget(footnoteId: string, internalId: string | null, lazyLoader: any): Promise<void> {
  try {
    console.log(`🎯 Starting footnote navigation to: ${footnoteId}, internal: ${internalId}`);

    // Clear any conflicting saved scroll positions to prevent interference
    const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
    console.log(`🧹 Clearing saved scroll positions to prevent navigation interference`);
    sessionStorage.removeItem(scrollKey);

    // Find the footnote sup element by ID in the document
    let footnoteElement = document.getElementById(footnoteId);

    // If not found, the chunk containing the footnote may not be loaded yet (lazy loading)
    // Use navigateToInternalId to find the correct chunk, load it, and scroll to it
    if (!footnoteElement && lazyLoader) {
      console.log(`📦 Footnote element not in DOM yet, loading chunk via navigateToInternalId: ${footnoteId}`);
      await navigateToInternalId(footnoteId, lazyLoader, false);

      // Wait for DOM to settle after chunk loading
      await new Promise(resolve => setTimeout(resolve, 300));

      // Retry finding the element now that the chunk should be loaded
      footnoteElement = document.getElementById(footnoteId);
    }

    if (!footnoteElement) {
      console.error(`❌ Footnote element not found even after chunk loading: ${footnoteId}`);
      // Fall back to navigating by internal ID if the element exists elsewhere
      if (internalId) {
        await navigateToInternalId(internalId, lazyLoader, false);
      }
      return;
    }

    // Play arrow-pulse animation on footnote for navigation emphasis
    footnoteElement.classList.add('arrow-target');
    const handleEnd = (e: Event) => {
      if (e.target === footnoteElement) {
        footnoteElement!.classList.remove('arrow-target');
        footnoteElement!.removeEventListener('animationend', handleEnd);
      }
    };
    footnoteElement.addEventListener('animationend', handleEnd);

    // Scroll to the footnote marker in the document. In paginated mode a
    // native scrollIntoView would scroll the overflow:hidden wrapper and
    // corrupt the page geometry — flip to the footnote's page instead.
    console.log(`📍 Scrolling to footnote element: ${footnoteId}`);
    if (!maybePaginatorReveal(footnoteElement)) {
      footnoteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Wait a moment for scroll to complete, then trigger the container to open
    await new Promise(resolve => setTimeout(resolve, 300));

    // Open the footnote in the hyperlit container
    console.log(`📝 Opening footnote in hyperlit container`);
    await handleUnifiedContentClick(footnoteElement);

    // If there's a hypercite to scroll to inside the container
    if (internalId) {
      const fnContainer = getCurrentContainer();
      // Wait for the hypercite element to be ready inside the container
      waitForElementReady(internalId, { maxAttempts: 20, checkInterval: 50, container: fnContainer })
        .then(() => {
          const hyperciteInContainer = fnContainer?.querySelector(`#${internalId}`);
          if (hyperciteInContainer) {
            console.log(`🎯 Found hypercite ${internalId} inside hyperlit container, scrolling to it`);
            if (!maybePaginatorReveal(hyperciteInContainer)) {
              hyperciteInContainer.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'nearest'
              });
            }
            // Check if this is a ghost tombstone — reveal instead of highlight
            if (!revealGhostIfTombstone(internalId)) {
              highlightTargetHypercite(internalId);
            }
          }
        })
        .catch(() => {
          console.log(`⚠️ Hypercite ${internalId} not found in container after waiting`);
          showTargetNotFoundToast({ target: internalId });
        });
    }

  } catch (error) {
    console.error(`❌ Error in footnote navigation:`, error);
    // Fallback: try to navigate by internal ID
    if (internalId) {
      await navigateToInternalId(internalId, lazyLoader, false);
    }
  }
}
