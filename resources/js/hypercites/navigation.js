/**
 * Hypercite Navigation & Click Routing
 *
 * Handles all click events for hypercites and routes them appropriately.
 * Manages navigation between books, highlights, and internal IDs.
 */

import { getActiveBook } from '../utilities/activeContext.js';
import { navigateToInternalId, showNavigationLoading } from '../scrolling.js';
import { waitForElementReady } from '../domReadiness.js';
import { getLocalStorageKey, openDatabase } from '../indexedDB/index.js';
import { getHyperciteData, getHyperciteById } from './database.js';
import { highlightTargetHypercite } from './animations.js';
import { createOverlappingPolyContainer } from './containers.js';
import { handleUnifiedContentClick, closeHyperlitContainer } from '../hyperlitContainer/index.js';
import { getCurrentContainer } from '../hyperlitContainer/stack.js';
import { currentLazyLoader } from '../initializePage.js';

/**
 * Handle couple click - navigates directly to the single citation
 * @param {HTMLElement} uElement - The couple element that was clicked
 */
export async function CoupleClick(uElement) {
  console.log("u.couple element clicked:", uElement);

  const parent = uElement.parentElement;
  if (!parent || !parent.id) {
    console.error("Parent element not found or missing id.", uElement);
    return;
  }
  console.log("Parent element found:", parent);

  const startLine = parent.id;
  const bookId = getActiveBook() || "latest";

  try {
    const nodeChunk = await getHyperciteData(bookId, startLine);
    if (!nodeChunk) {
      console.error(
        `No nodeChunk found for book: ${bookId}, startLine: ${startLine}`
      );
      return;
    }
    console.log("Retrieved nodeChunk:", nodeChunk);

    const clickedHyperciteId = uElement.id;
    let link = null;

    if (nodeChunk.hypercites && nodeChunk.hypercites.length > 0) {
      const matchingHypercite = nodeChunk.hypercites.find(
        (hyper) => hyper.hyperciteId === clickedHyperciteId
      );

      if (
        matchingHypercite &&
        matchingHypercite.citedIN &&
        matchingHypercite.citedIN.length > 0
      ) {
        link = matchingHypercite.citedIN[0];
      }
    }

    if (link) {
      await navigateToHyperciteLink(link, clickedHyperciteId);
    } else {
      console.error(
        "No citedIN link found for clicked hyperciteId:",
        clickedHyperciteId,
        nodeChunk
      );
    }
  } catch (error) {
    console.error("Failed to retrieve hypercite data:", error);
  }
}

/**
 * Handle underline clicks - delegates to unified container system
 * @param {HTMLElement} uElement - The underlined element that was clicked
 * @param {Event} event - The click event
 */
export async function handleUnderlineClick(uElement, event) {
  console.log("🔥 handleUnderlineClick called with element:", uElement.id || uElement.tagName);

  // Use unified container system for all hypercite clicks
  console.log("🔄 Calling handleUnifiedContentClick from hyperCites.js");
  await handleUnifiedContentClick(uElement);
}

/**
 * Handle overlapping hypercite clicks
 * @param {HTMLElement} uElement - The overlapping hypercite element
 * @param {Event} event - The click event
 */
export async function handleOverlappingHyperciteClick(uElement, event) {
  console.log("Overlapping hypercite clicked:", uElement);

  // Update URL for back button support - use the first hypercite ID
  const overlappingData = uElement.getAttribute("data-overlapping");
  if (!overlappingData) {
    console.error("❌ No data-overlapping attribute found");
    return;
  }

  const hyperciteIds = overlappingData.split(",").map(id => id.trim());
  console.log("Overlapping hypercite IDs:", hyperciteIds);

  // Add URL update for back button functionality
  if (hyperciteIds.length > 0) {
    const firstHyperciteId = hyperciteIds[0].replace('hypercite_', '');
    const newUrl = `${window.location.pathname}${window.location.search}#hypercite_${firstHyperciteId}`;
    console.log(`📍 Updating URL for overlapping hypercite navigation: ${newUrl}`);

    try {
      // Preserve existing state when updating URL for overlapping hypercite
      const currentState = history.state || {};
      const newState = { ...currentState, overlapping_hypercite: { hyperciteIds: hyperciteIds } };
      history.replaceState(newState, '', newUrl);
      console.log(`📊 Updated URL for overlapping hypercite (replaceState, no new history entry)`);
    } catch (error) {
      console.warn('Failed to update URL for overlapping hypercite:', error);
    }
  }

  // Always show container for overlapping hypercites (regardless of relationship status)
  console.log("📝 Showing container for overlapping hypercites");

  try {
    const db = await openDatabase();

    // Look up all hypercites
    const hypercitePromises = hyperciteIds.map(id => getHyperciteById(db, id));
    const hypercites = await Promise.all(hypercitePromises);

    // Filter out null results and collect all citedIN links
    const validHypercites = hypercites.filter(hc => hc !== null);
    const allCitedINLinks = [];

    validHypercites.forEach(hypercite => {
      if (hypercite.citedIN && Array.isArray(hypercite.citedIN)) {
        allCitedINLinks.push(...hypercite.citedIN);
      }
    });

    console.log("All citedIN links from overlapping hypercites:", allCitedINLinks);

    if (allCitedINLinks.length === 0) {
      console.error("❌ No citedIN links found in any overlapping hypercites");
      return;
    }

    // Create the container with all links
    await createOverlappingPolyContainer(allCitedINLinks, validHypercites);

  } catch (error) {
    console.error("❌ Error handling overlapping hypercite click:", error);
  }
}

/**
 * Handle overlapping hypercites with couple class
 * @param {Array} hyperciteIds - Array of overlapping hypercite IDs
 */
export async function handleOverlappingCouple(hyperciteIds) {
  try {
    const db = await openDatabase();

    // Look up all hypercites to find which one has couple status
    const hypercitePromises = hyperciteIds.map(id => getHyperciteById(db, id));
    const hypercites = await Promise.all(hypercitePromises);

    // Find the hypercite with couple relationship status
    const coupleHypercite = hypercites.find(hc =>
      hc && hc.relationshipStatus === "couple"
    );

    if (!coupleHypercite) {
      console.error("❌ No hypercite with couple status found in overlapping set");
      return;
    }

    console.log("Found couple hypercite:", coupleHypercite);

    // Get the citedIN link (should be exactly one for couple status)
    if (coupleHypercite.citedIN && coupleHypercite.citedIN.length > 0) {
      const link = coupleHypercite.citedIN[0];
      await navigateToHyperciteLink(link);
    } else {
      console.error("❌ No citedIN link found for couple hypercite:", coupleHypercite.hyperciteId);
    }

  } catch (error) {
    console.error("❌ Error handling overlapping couple:", error);
  }
}

/**
 * Handle overlapping hypercites with poly class
 * @param {Array} hyperciteIds - Array of overlapping hypercite IDs
 * @param {Event} event - The click event
 */
export async function handleOverlappingPoly(hyperciteIds, event) {
  try {
    const db = await openDatabase();

    // Look up all hypercites
    const hypercitePromises = hyperciteIds.map(id => getHyperciteById(db, id));
    const hypercites = await Promise.all(hypercitePromises);

    // Filter out null results and collect all citedIN links
    const validHypercites = hypercites.filter(hc => hc !== null);
    const allCitedINLinks = [];

    validHypercites.forEach(hypercite => {
      if (hypercite.citedIN && Array.isArray(hypercite.citedIN)) {
        allCitedINLinks.push(...hypercite.citedIN);
      }
    });

    console.log("All citedIN links from overlapping hypercites:", allCitedINLinks);

    if (allCitedINLinks.length === 0) {
      console.error("❌ No citedIN links found in any overlapping hypercites");
      return;
    }

    // Create the poly container content with all links
    await createOverlappingPolyContainer(allCitedINLinks, validHypercites);

  } catch (error) {
    console.error("❌ Error handling overlapping poly:", error);
  }
}

/**
 * Navigate to hypercite targets with proper sequencing and DOM readiness
 * @param {string} highlightId - The highlight ID to navigate to first
 * @param {string} internalId - Optional internal ID to navigate to after highlight
 * @param {Object} lazyLoader - The lazy loader instance
 * @param {boolean} showOverlay - Whether to show loading overlay
 */
export async function navigateToHyperciteTarget(highlightId, internalId, lazyLoader, showOverlay = false) {
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
        const scroller = currentContainer.querySelector('.scroller');
        if (scroller) {
          hyperciteInContainer.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'nearest'
          });
          // Highlight the hypercite
          highlightTargetHypercite(internalId, 500);
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
 * @param {string} footnoteId - The footnote ID to navigate to (e.g., "bookId_Fn1234")
 * @param {string} internalId - Optional internal hypercite ID to scroll to after opening
 * @param {Object} lazyLoader - The lazy loader instance
 */
export async function navigateToFootnoteTarget(footnoteId, internalId, lazyLoader) {
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
    const handleEnd = (e) => {
      if (e.target === footnoteElement) {
        footnoteElement.classList.remove('arrow-target');
        footnoteElement.removeEventListener('animationend', handleEnd);
      }
    };
    footnoteElement.addEventListener('animationend', handleEnd);

    // Scroll to the footnote marker in the document
    console.log(`📍 Scrolling to footnote element: ${footnoteId}`);
    footnoteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Wait a moment for scroll to complete, then trigger the container to open
    await new Promise(resolve => setTimeout(resolve, 300));

    // Open the footnote in the hyperlit container
    console.log(`📝 Opening footnote in hyperlit container`);
    await handleUnifiedContentClick(footnoteElement);

    // If there's a hypercite to scroll to inside the container
    if (internalId) {
      // Wait for the container to render
      setTimeout(() => {
        const fnContainer = getCurrentContainer();
        const hyperciteInContainer = fnContainer?.querySelector(`#${internalId}`);
        if (hyperciteInContainer) {
          console.log(`🎯 Found hypercite ${internalId} inside hyperlit container, scrolling to it`);
          hyperciteInContainer.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'nearest'
          });
          // Highlight the hypercite
          highlightTargetHypercite(internalId, 500);
        } else {
          console.log(`⚠️ Hypercite ${internalId} not found in container`);
        }
      }, 400);
    }

  } catch (error) {
    console.error(`❌ Error in footnote navigation:`, error);
    // Fallback: try to navigate by internal ID
    if (internalId) {
      await navigateToInternalId(internalId, lazyLoader, false);
    }
  }
}

/**
 * Navigate to a hypercite link
 * @param {string} link - The link to navigate to
 * @param {string} clickedHyperciteId - The ID of the clicked hypercite (for loading overlay)
 */
export async function navigateToHyperciteLink(link, clickedHyperciteId = "hypercite_link") {
  // If the link is relative, prepend the base URL
  if (link.startsWith("/")) {
    link = window.location.origin + link;
  }
  console.log("Opening link:", link);

  // Check if this is a same-book highlight link
  const url = new URL(link, window.location.origin);
  if (url.origin === window.location.origin) {
    // Close any open container before navigating to a same-book target
    if (document.body.classList.contains('hyperlit-container-open')) {
      try {
        await closeHyperlitContainer(true);
      } catch (e) { /* ignore */ }
    }

    const allSegments = url.pathname.split("/").filter(Boolean);
    const bookSegment = allSegments[0];
    const currentBook = window.location.pathname.split("/").filter(Boolean)[0];

    // Scan ALL segments for HL_ and Fn patterns (not just index 1 — page numbers may appear before them)
    const hlSegment = allSegments.find(p => p.startsWith('HL_'));
    const fnSegment = allSegments.find(p => p.includes('_Fn') || /^Fn\d/.test(p));
    const internalId = url.hash ? url.hash.slice(1) : null;

    if (bookSegment === currentBook && fnSegment && hlSegment) {
      console.log("✅ Same-book multi-level cascade detected in hypercite");
      const { openContainerChain, buildChainFromUrl } = await import('../initializePage.js');
      const chain = await buildChainFromUrl(bookSegment, allSegments);
      if (chain.length > 0) {
        await openContainerChain(chain, currentLazyLoader, internalId || null);
        return; // Don't do normal navigation
      }
    }

    if (bookSegment === currentBook && hlSegment) {
      console.log("✅ Same-book highlight link detected in hypercite");

      // Use proper sequential navigation with DOM readiness
      await navigateToHyperciteTarget(hlSegment, internalId, currentLazyLoader);

      return; // Don't do normal navigation
    }

    if (bookSegment === currentBook && fnSegment) {
      console.log("✅ Same-book footnote link detected in hypercite");

      // Navigate to footnote and open in container
      await navigateToFootnoteTarget(fnSegment, internalId, currentLazyLoader);

      return; // Don't do normal navigation
    }

    if (bookSegment === currentBook) {
      console.log("✅ Same-book internal link detected");
      const internalId = url.hash ? url.hash.slice(1) : null;

      if (internalId) {
        await navigateToInternalId(internalId, currentLazyLoader, false); // Don't show overlay - internal navigation
        return;
      }
    }
  }

  // If not a same-book highlight, do normal navigation
  // Show overlay for external navigation
  showNavigationLoading(clickedHyperciteId);
  window.location.href = link;
}
