// DOM Readiness Detection Utilities for Hyperlit Navigation
// Provides reliable element detection for lazy-loaded content
import { log, verbose } from "../utilities/logger";

/**
 * Checks if an element is fully rendered and ready for interaction
 * @param {HTMLElement} element - The element to check
 * @returns {boolean} - True if element is ready
 */
function isElementFullyRendered(element: any) {
  if (!element) return false;

  // Check basic DOM presence
  if (!document.contains(element)) return false;

  // 🚀 iOS Safari fix: Force layout reflow before measuring dimensions
  // This ensures computed styles are up to date, especially important on mobile
  // where paint cycles may be slower than dimension checks
  void element.offsetHeight;

  // Check if element has been laid out (has dimensions)
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // Ghost hypercite tombstones are invisible anchors — skip dimension check
    if (element.hasAttribute('data-ghost') && element.id.startsWith('hypercite_')) {
      return true;
    }
    return false;
  }

  // For highlights/hypercites, check if they have expected classes/attributes
  if (element.tagName === 'MARK' && (element.id.startsWith('HL_') || element.id === 'HL_overlap')) {
    // Highlight should have proper classes applied
    const hasClasses = element.className && element.className.length > 0;

    if (!hasClasses) {
      return false;
    }

    // Check if highlight has proper data attributes
    if (!element.hasAttribute('data-highlight-count')) {
      return false;
    }
    
    // Check if CSS styling has been applied (background color should be visible)
    const computedStyle = window.getComputedStyle(element);
    const hasBackground = computedStyle.backgroundColor && 
                         computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                         computedStyle.backgroundColor !== 'transparent';
    
    if (!hasBackground) {
      return false;
    }
    
    return true;
  }
  
  if (element.tagName === 'U' && (element.id.startsWith('hypercite_') || element.id === 'hypercite_overlapping')) {
    // Hypercite should have relationship status class - that's sufficient for readiness
    const hasValidClass = element.classList.contains('single') || 
                          element.classList.contains('couple') || 
                          element.classList.contains('poly');
    
    if (!hasValidClass) {
      return false;
    }

    // If it has the right class and dimensions, it's ready
    return true;
  }
  
  return true;
}

/**
 * Waits for an element to be ready with proper error handling and timeout
 * @param {string} targetId - The ID of the element to wait for
 * @param {Object} options - Configuration options
 * @returns {Promise<HTMLElement>} - Resolves with the element when ready
 */
export function waitForElementReady(targetId: string, options: any = {}) {
  const {
    maxAttempts = 20,        // Maximum number of attempts
    checkInterval = 50,      // Milliseconds between checks
    container = document,    // Container to search within
    requireVisible = false,  // Whether element must be visible
    onProgress = null        // Progress callback function
  } = options;
  
  return new Promise<any>((resolve, reject) => {
    let attempts = 0;
    let startTime = Date.now();

    const checkElement = () => {
      attempts++;
      
      // Find element within the specified container
      let element = container.querySelector(`#${CSS.escape(targetId)}`);

      // For highlights, also check by class (overlapping highlights use id="HL_overlap")
      if (!element && targetId.startsWith('HL_')) {
        element = container.querySelector(`mark.${CSS.escape(targetId)}`);
      }

      // For hypercites, also check overlapping elements if direct element not found
      if (!element && targetId.startsWith('hypercite_')) {
        const overlappingElements = container.querySelectorAll('u[data-overlapping]');
        for (const overlappingElement of overlappingElements) {
          const overlappingIds = overlappingElement.getAttribute('data-overlapping');
          if (overlappingIds && overlappingIds.split(',').map((id: any) => id.trim()).includes(targetId)) {
            element = overlappingElement;
            break;
          }
        }
      }
      
      if (onProgress) {
        onProgress({ attempts, targetId, found: !!element });
      }
      
      if (element && isElementFullyRendered(element)) {
        // Additional visibility check if required
        if (requireVisible) {
          const rect = element.getBoundingClientRect();
          const isVisible = rect.top >= 0 && rect.left >= 0 && 
                           rect.bottom <= window.innerHeight && 
                           rect.right <= window.innerWidth;
          
          if (!isVisible) {
            if (attempts >= maxAttempts) {
              reject(new Error(`Element ${targetId} found but never became visible after ${attempts} attempts`));
              return;
            }
            setTimeout(checkElement, checkInterval);
            return;
          }
        }

        resolve(element);

      } else if (attempts >= maxAttempts) {
        const elapsedTime = Date.now() - startTime;
        const error = element 
          ? `Element ${targetId} found but not fully rendered after ${attempts} attempts (${elapsedTime}ms)`
          : `Element ${targetId} not found after ${attempts} attempts (${elapsedTime}ms)`;

        reject(new Error(error));

      } else {
        // Continue checking
        setTimeout(checkElement, checkInterval);
      }
    };
    
    // Start checking immediately
    checkElement();
  });
}

/**
 * Waits for an element to be ready with progress bar integration
 * Hides progress bar when element becomes visually ready, before navigation
 * @param {string} targetId - The ID of the element to wait for
 * @param {Function} progressCallback - Progress callback function
 * @param {Object} options - Configuration options
 * @returns {Promise<HTMLElement>} - Resolves with the element when ready
 */
export function waitForElementReadyWithProgress(targetId: string, progressCallback: any, options: any = {}) {
  const {
    hideProgressAtPercent = 95,  // Hide progress when element is ready but before navigation
    hideProgressMessage = 'Element ready',
    ...waitOptions
  } = options;

  let progressHidden = false;
  
  return waitForElementReady(targetId, {
    ...waitOptions,
    onProgress: ({ attempts, targetId, found }: any) => {
      if (found && !progressHidden) {
        // Element exists - check if it's visually ready
        const element = document.querySelector(`#${CSS.escape(targetId)}`);
        if (element && isElementFullyRendered(element)) {
          // 🎯 CRITICAL: Element is visually ready - hide progress bar NOW
          progressCallback(hideProgressAtPercent, `${targetId} ${hideProgressMessage}`);

          // Import and hide progress overlay
          import('../SPA/navigation/ProgressOverlayEnactor.js').then(({ ProgressOverlayEnactor }) => {
            ProgressOverlayEnactor.hide();
          }).catch(() => { /* non-fatal */ });

          progressHidden = true;
          return true; // Signal that we can proceed
        }
      }
      return false;
    }
  });
}

/**
 * Waits for multiple elements to be ready simultaneously
 * @param {string[]} targetIds - Array of element IDs to wait for
 * @param {Object} options - Configuration options
 * @returns {Promise<HTMLElement[]>} - Resolves with array of elements when all ready
 */
export function waitForMultipleElementsReady(targetIds: any[], options: any = {}) {
  const promises = targetIds.map((id: any) => waitForElementReady(id, options));

  return Promise.all(promises).then(elements => {
    return elements;
  });
}

/**
 * Waits for multiple elements with progress integration
 * Hides progress when all elements are visually ready
 * @param {string[]} targetIds - Array of element IDs to wait for
 * @param {Function} progressCallback - Progress callback function
 * @param {Object} options - Configuration options
 * @returns {Promise<HTMLElement[]>} - Resolves with array of elements when all ready
 */
export function waitForMultipleElementsReadyWithProgress(targetIds: any[], progressCallback: any, options: any = {}) {
  const {
    hideProgressAtPercent = 95,
    hideProgressMessage = 'Elements ready',
    ...waitOptions
  } = options;

  let progressHidden = false;
  let readyCount = 0;
  
  const promises = targetIds.map((id: any) => 
    waitForElementReady(id, {
      ...waitOptions,
      onProgress: ({ attempts, targetId, found }: any) => {
        if (found && !progressHidden) {
          const element = document.querySelector(`#${CSS.escape(targetId)}`);
          if (element && isElementFullyRendered(element)) {
            readyCount++;
            
            // Hide progress when all elements are ready
            if (readyCount >= targetIds.length) {
              progressCallback(hideProgressAtPercent, hideProgressMessage);

              import('../SPA/navigation/ProgressOverlayEnactor.js').then(({ ProgressOverlayEnactor }) => {
                ProgressOverlayEnactor.hide();
              }).catch(() => { /* non-fatal */ });

              progressHidden = true;
            }
            return true;
          }
        }
        return false;
      }
    })
  );
  
  return Promise.all(promises).then(elements => {
    return elements;
  });
}

/**
 * Waits for chunk loading to complete by monitoring DOM mutations
 * @param {HTMLElement} container - Container to monitor
 * @param {number} chunkId - ID of chunk being loaded
 * @param {number} timeoutMs - Maximum time to wait
 * @returns {Promise<void>} - Resolves when chunk loading appears complete
 */
export function waitForChunkLoadingComplete(container: any, chunkId: any, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    let mutationTimer: any = null;
    let hasSeenChunk = false;

    // Check if chunk already exists
    const existingChunk = container.querySelector(`[data-chunk-id="${chunkId}"]`);
    if (existingChunk) {
      resolve();
      return;
    }
    
    const observer = new MutationObserver((mutations) => {
      let chunkMutationDetected = false;
      
      mutations.forEach(mutation => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if this is our chunk or contains our chunk
              if ((node as any).getAttribute?.('data-chunk-id') == chunkId || 
                  (node as any).querySelector?.(` [data-chunk-id="${chunkId}"]`)) {
                hasSeenChunk = true;
                chunkMutationDetected = true;
              }
            }
          });
        }
      });
      
      if (chunkMutationDetected) {
        // Reset the timer - more changes might be coming
        clearTimeout(mutationTimer);
        mutationTimer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 200); // Wait 200ms after last mutation to allow for styling
      }
    });
    
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: false
    });
    
    // Overall timeout
    setTimeout(() => {
      observer.disconnect();
      clearTimeout(mutationTimer);
      
      if (hasSeenChunk) {
        resolve();
      } else {
        reject(new Error(`Timeout waiting for chunk ${chunkId} after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

/**
 * Wait for fonts to load before navigation
 * @returns {Promise<void>}
 */
async function waitForFontsReady() {
  if (!document.fonts) {
    return;
  }

  try {
    await document.fonts.ready;
  } catch (error) {
    // Continue anyway
  }
}

/**
 * Wait for potential layout-shifting operations to complete
 * @returns {Promise<void>}
 */
export async function waitForLayoutStabilization() {
  return new Promise<void>(resolve => {
    // Wait for any pending layout operations
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        verbose.init('waitForLayoutStabilization complete', '/SPA/domReadiness.ts')
        resolve();
      });
    });
  });
}

/**
 * Combined function: Wait for chunk loading, then wait for specific element
 * This is the main function you'll use for navigation
 * @param {string} targetId - Element ID to wait for
 * @param {HTMLElement} container - Container being loaded into
 * @param {number} expectedChunkId - Chunk ID that should contain the element
 * @param {Object} options - Additional options
 * @returns {Promise<HTMLElement>} - Resolves with ready element
 */
export async function waitForNavigationTarget(targetId: string, container: any, expectedChunkId: any = null, options: any = {}) {
  const { 
    maxWaitTime = 10000,
    requireVisible = false
  } = options;

  try {
    // If we know which chunk should contain the element, wait for that chunk first
    if (expectedChunkId !== null) {
      await waitForChunkLoadingComplete(container, expectedChunkId, maxWaitTime / 2);
    }
    
    // Wait for fonts to load (common cause of layout shifts)
    await waitForFontsReady();
    
    // Wait for layout to stabilize
    await waitForLayoutStabilization();
    
    // Now wait for the specific element to be ready
    const element = await waitForElementReady(targetId, {
      maxAttempts: maxWaitTime / 50, // 50ms intervals
      checkInterval: 50,
      container,
      requireVisible
    });
    
    console.log(`🎯 Navigation target ready: ${targetId}`);
    return element;
    
  } catch (error) {
    // WARN, not ERROR: a target not appearing within the timeout is a recoverable/expected
    // condition (deep chunk not yet loaded, or a stale/superseded target left over from a
    // rapid cross-book nav), and every caller already handles the throw with its own fallback
    // (internalNav fallback chunk + toast, BookToBookTransition try/catch). Logging at error
    // level made these benign timeouts trip the e2e no-console-errors gate. The throw is kept
    // so callers' fallback logic still runs.
    console.warn(`⚠️ Navigation target ${targetId} did not become ready before timeout (falling back):`, error);
    throw error;
  }
}

/**
 * Wait for content to be fully loaded and ready for use
 * This ensures nodes are available and lazy loader is properly initialized
 * @param {string} bookId - The book ID to wait for
 * @param {Object} options - Configuration options
 * @returns {Promise<void>} - Resolves when content is ready
 */
export async function waitForContentReady(bookId: string, options: any = {}) {
  const {
    maxWaitTime = 15000,    // Maximum time to wait (15 seconds)
    checkInterval = 100,    // Check every 100ms
    requireLazyLoader = true // Whether to require lazy loader to be ready
  } = options;
  
  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    let attempts = 0;

    const checkContentReady = () => {
      attempts++;
      const elapsed = Date.now() - startTime;
      
      // Check if we've exceeded max wait time
      if (elapsed > maxWaitTime) {
        reject(new Error(`Content readiness timeout for ${bookId} after ${elapsed}ms (${attempts} attempts)`));
        return;
      }
      
      // Check 1: nodes must be available
      if (!(window as any).nodes || (window as any).nodes.length === 0) {
        setTimeout(checkContentReady, checkInterval);
        return;
      }
      
      // Check 2: Lazy loader must be initialized if required
      if (requireLazyLoader) {
        // Import dynamically to avoid circular dependencies
        import('../pageLoad/currentLazyLoaderState').then(({ currentLazyLoader }) => {
          if (!currentLazyLoader) {
            setTimeout(checkContentReady, checkInterval);
            return;
          }

          // Check 3: Lazy loader must have the correct book ID
          if (currentLazyLoader.bookId !== bookId) {
            setTimeout(checkContentReady, checkInterval);
            return;
          }

          // Check 4: Container must exist in DOM
          const container = document.getElementById(bookId);
          if (!container) {
            setTimeout(checkContentReady, checkInterval);
            return;
          }

          // All checks passed!
          resolve();

        }).catch(error => {
          // Continue without lazy loader check
          setTimeout(checkContentReady, checkInterval);
        });
      } else {
        // Skip lazy loader check, just verify container exists
        const container = document.getElementById(bookId);
        if (!container) {
          setTimeout(checkContentReady, checkInterval);
          return;
        }

        // All checks passed (without lazy loader)
        resolve();
      }
    };
    
    // Start checking immediately
    checkContentReady();
  });
}

/**
 * Comprehensive content and navigation readiness check
 * Combines layout stabilization, content readiness, and optional navigation target waiting
 * @param {string} bookId - The book ID 
 * @param {Object} options - Configuration options
 * @returns {Promise<void>} - Resolves when everything is ready
 */
export async function waitForCompleteReadiness(bookId: string, options: any = {}) {
  const {
    targetId = null,        // Optional navigation target to wait for
    maxWaitTime = 20000,    // Total maximum wait time
    requireLazyLoader = true
  } = options;

  try {
    // Step 1: Wait for layout stabilization
    await waitForLayoutStabilization();

    // Step 2: Wait for content to be ready
    await waitForContentReady(bookId, {
      maxWaitTime: maxWaitTime * 0.7, // Use 70% of total time for content
      requireLazyLoader 
    });
    
    // Step 3: If navigation target specified, wait for it
    if (targetId) {
      const container = document.getElementById(bookId) || document.body;
      await waitForElementReady(targetId, {
        maxAttempts: (maxWaitTime * 0.3) / 50, // Use remaining 30% of time
        checkInterval: 50,
        container
      });
    }

  } catch (error) {
    log.error(`❌ Complete readiness failed for ${bookId}:`, '/SPA/domReadiness.ts', error);
    throw error;
  }
}

export { isElementFullyRendered };