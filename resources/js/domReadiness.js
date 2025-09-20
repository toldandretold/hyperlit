// DOM Readiness Detection Utilities for Hyperlit Navigation
// Provides reliable element detection for lazy-loaded content

/**
 * Checks if an element is fully rendered and ready for interaction
 * @param {HTMLElement} element - The element to check
 * @returns {boolean} - True if element is ready
 */
function isElementFullyRendered(element) {
  if (!element) return false;
  
  // Check basic DOM presence
  if (!document.contains(element)) return false;
  
  // Check if element has been laid out (has dimensions)
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  
  // For highlights/hypercites, check if they have expected classes/attributes
  if (element.tagName === 'MARK' && (element.id.startsWith('HL_') || element.id === 'HL_overlap')) {
    // Highlight should have proper classes applied
    const hasClasses = element.className && element.className.length > 0;
    
    if (!hasClasses) {
      console.log(`🔍 Highlight ${element.id} missing classes`);
      return false;
    }
    
    // Check if highlight has proper data attributes
    if (!element.hasAttribute('data-highlight-count')) {
      console.log(`🔍 Highlight ${element.id} missing data-highlight-count attribute`);
      return false;
    }
    
    // Check if CSS styling has been applied (background color should be visible)
    const computedStyle = window.getComputedStyle(element);
    const hasBackground = computedStyle.backgroundColor && 
                         computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                         computedStyle.backgroundColor !== 'transparent';
    
    if (!hasBackground) {
      console.log(`🔍 Highlight ${element.id} missing background styling`);
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
      console.log(`🔍 Hypercite ${element.id} missing relationship class. Classes: ${element.className}`);
      return false;
    }
    
    // If it has the right class and dimensions, it's ready
    console.log(`✅ Hypercite ${element.id} ready with class: ${element.className}`);
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
export function waitForElementReady(targetId, options = {}) {
  const {
    maxAttempts = 20,        // Maximum number of attempts
    checkInterval = 50,      // Milliseconds between checks
    container = document,    // Container to search within
    requireVisible = false,  // Whether element must be visible
    onProgress = null        // Progress callback function
  } = options;
  
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let startTime = Date.now();
    
    console.log(`⏳ Waiting for element: ${targetId} (max ${maxAttempts} attempts)`);
    
    const checkElement = () => {
      attempts++;
      
      // Find element within the specified container
      let element = container.querySelector(`#${CSS.escape(targetId)}`);
      
      // For hypercites, also check overlapping elements if direct element not found
      if (!element && targetId.startsWith('hypercite_')) {
        const overlappingElements = container.querySelectorAll('u[data-overlapping]');
        for (const overlappingElement of overlappingElements) {
          const overlappingIds = overlappingElement.getAttribute('data-overlapping');
          if (overlappingIds && overlappingIds.split(',').map(id => id.trim()).includes(targetId)) {
            console.log(`🎯 Found hypercite ${targetId} in overlapping element during DOM readiness check`);
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
            console.log(`📍 Element ${targetId} found but not visible (attempt ${attempts})`);
            if (attempts >= maxAttempts) {
              reject(new Error(`Element ${targetId} found but never became visible after ${attempts} attempts`));
              return;
            }
            setTimeout(checkElement, checkInterval);
            return;
          }
        }
        
        const elapsedTime = Date.now() - startTime;
        console.log(`✅ Element ${targetId} ready after ${attempts} attempts (${elapsedTime}ms)`);
        resolve(element);
        
      } else if (attempts >= maxAttempts) {
        const elapsedTime = Date.now() - startTime;
        const error = element 
          ? `Element ${targetId} found but not fully rendered after ${attempts} attempts (${elapsedTime}ms)`
          : `Element ${targetId} not found after ${attempts} attempts (${elapsedTime}ms)`;
        
        console.warn(`❌ ${error}`);
        reject(new Error(error));
        
      } else {
        // Continue checking
        if (attempts % 5 === 0) {
          console.log(`⏳ Still waiting for ${targetId}... (attempt ${attempts}/${maxAttempts})`);
        }
        setTimeout(checkElement, checkInterval);
      }
    };
    
    // Start checking immediately
    checkElement();
  });
}

/**
 * Waits for multiple elements to be ready simultaneously
 * @param {string[]} targetIds - Array of element IDs to wait for
 * @param {Object} options - Configuration options
 * @returns {Promise<HTMLElement[]>} - Resolves with array of elements when all ready
 */
export function waitForMultipleElementsReady(targetIds, options = {}) {
  console.log(`⏳ Waiting for multiple elements: ${targetIds.join(', ')}`);
  
  const promises = targetIds.map(id => waitForElementReady(id, options));
  
  return Promise.all(promises).then(elements => {
    console.log(`✅ All elements ready: ${targetIds.join(', ')}`);
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
export function waitForChunkLoadingComplete(container, chunkId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let mutationTimer = null;
    let hasSeenChunk = false;
    
    console.log(`⏳ Waiting for chunk ${chunkId} loading to complete...`);
    
    // Check if chunk already exists
    const existingChunk = container.querySelector(`[data-chunk-id="${chunkId}"]`);
    if (existingChunk) {
      console.log(`✅ Chunk ${chunkId} already loaded`);
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
              if (node.getAttribute?.('data-chunk-id') == chunkId || 
                  node.querySelector?.(` [data-chunk-id="${chunkId}"]`)) {
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
          console.log(`✅ Chunk ${chunkId} loading complete (mutations settled)`);
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
        console.log(`✅ Chunk ${chunkId} loading timeout reached, but chunk was seen`);
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
    console.log(`📝 Font API not available, skipping font wait`);
    return;
  }
  
  try {
    console.log(`📝 Waiting for fonts to load...`);
    await document.fonts.ready;
    console.log(`📝 Fonts loaded successfully`);
  } catch (error) {
    console.warn(`📝 Font loading error (continuing anyway):`, error);
  }
}

/**
 * Wait for potential layout-shifting operations to complete
 * @returns {Promise<void>}
 */
export async function waitForLayoutStabilization() {
  return new Promise(resolve => {
    console.log(`📐 Waiting for layout stabilization...`);
    
    // Wait for any pending layout operations
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        console.log(`📐 Layout stabilization complete`);
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
export async function waitForNavigationTarget(targetId, container, expectedChunkId = null, options = {}) {
  const { 
    maxWaitTime = 10000,
    requireVisible = false 
  } = options;
  
  console.log(`🎯 Waiting for navigation target: ${targetId} (chunk: ${expectedChunkId})`);
  
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
    console.error(`❌ Failed to wait for navigation target ${targetId}:`, error);
    throw error;
  }
}

/**
 * Wait for content to be fully loaded and ready for use
 * This ensures nodeChunks are available and lazy loader is properly initialized
 * @param {string} bookId - The book ID to wait for
 * @param {Object} options - Configuration options
 * @returns {Promise<void>} - Resolves when content is ready
 */
export async function waitForContentReady(bookId, options = {}) {
  const {
    maxWaitTime = 15000,    // Maximum time to wait (15 seconds)
    checkInterval = 100,    // Check every 100ms
    requireLazyLoader = true // Whether to require lazy loader to be ready
  } = options;
  
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let attempts = 0;
    
    console.log(`⏳ Waiting for content to be ready for book: ${bookId}`);
    
    const checkContentReady = () => {
      attempts++;
      const elapsed = Date.now() - startTime;
      
      // Check if we've exceeded max wait time
      if (elapsed > maxWaitTime) {
        reject(new Error(`Content readiness timeout for ${bookId} after ${elapsed}ms (${attempts} attempts)`));
        return;
      }
      
      // Check 1: nodeChunks must be available
      if (!window.nodeChunks || window.nodeChunks.length === 0) {
        if (attempts % 10 === 0) {
          console.log(`⏳ Still waiting for nodeChunks... (attempt ${attempts}, ${elapsed}ms)`);
        }
        setTimeout(checkContentReady, checkInterval);
        return;
      }
      
      // Check 2: Lazy loader must be initialized if required
      if (requireLazyLoader) {
        // Import dynamically to avoid circular dependencies
        import('./initializePage.js').then(({ currentLazyLoader }) => {
          if (!currentLazyLoader) {
            if (attempts % 10 === 0) {
              console.log(`⏳ Still waiting for lazy loader... (attempt ${attempts}, ${elapsed}ms)`);
            }
            setTimeout(checkContentReady, checkInterval);
            return;
          }
          
          // Check 3: Lazy loader must have the correct book ID
          if (currentLazyLoader.bookId !== bookId) {
            if (attempts % 10 === 0) {
              console.log(`⏳ Lazy loader book ID mismatch (${currentLazyLoader.bookId} !== ${bookId}) (attempt ${attempts}, ${elapsed}ms)`);
            }
            setTimeout(checkContentReady, checkInterval);
            return;
          }
          
          // Check 4: Container must exist in DOM
          const container = document.getElementById(bookId);
          if (!container) {
            if (attempts % 10 === 0) {
              console.log(`⏳ Still waiting for container #${bookId}... (attempt ${attempts}, ${elapsed}ms)`);
            }
            setTimeout(checkContentReady, checkInterval);
            return;
          }
          
          // All checks passed!
          console.log(`✅ Content ready for ${bookId} after ${attempts} attempts (${elapsed}ms)`);
          console.log(`   - nodeChunks: ${window.nodeChunks.length} chunks available`);
          console.log(`   - lazyLoader: initialized with book ${currentLazyLoader.bookId}`);
          console.log(`   - container: #${bookId} found in DOM`);
          resolve();
          
        }).catch(error => {
          console.warn('Error importing initializePage.js:', error);
          // Continue without lazy loader check
          if (attempts % 10 === 0) {
            console.log(`⏳ Lazy loader check failed, continuing... (attempt ${attempts}, ${elapsed}ms)`);
          }
          setTimeout(checkContentReady, checkInterval);
        });
      } else {
        // Skip lazy loader check, just verify container exists
        const container = document.getElementById(bookId);
        if (!container) {
          if (attempts % 10 === 0) {
            console.log(`⏳ Still waiting for container #${bookId}... (attempt ${attempts}, ${elapsed}ms)`);
          }
          setTimeout(checkContentReady, checkInterval);
          return;
        }
        
        // All checks passed (without lazy loader)
        console.log(`✅ Content ready for ${bookId} after ${attempts} attempts (${elapsed}ms) - no lazy loader required`);
        console.log(`   - nodeChunks: ${window.nodeChunks.length} chunks available`);
        console.log(`   - container: #${bookId} found in DOM`);
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
export async function waitForCompleteReadiness(bookId, options = {}) {
  const {
    targetId = null,        // Optional navigation target to wait for
    maxWaitTime = 20000,    // Total maximum wait time
    requireLazyLoader = true
  } = options;
  
  console.log(`🎯 Starting complete readiness check for ${bookId}`, { targetId, maxWaitTime });
  
  try {
    // Step 1: Wait for layout stabilization
    console.log(`📐 Step 1: Layout stabilization`);
    await waitForLayoutStabilization();
    
    // Step 2: Wait for content to be ready
    console.log(`📄 Step 2: Content readiness`);
    await waitForContentReady(bookId, { 
      maxWaitTime: maxWaitTime * 0.7, // Use 70% of total time for content
      requireLazyLoader 
    });
    
    // Step 3: If navigation target specified, wait for it
    if (targetId) {
      console.log(`🎯 Step 3: Navigation target readiness`);
      const container = document.getElementById(bookId) || document.body;
      await waitForElementReady(targetId, {
        maxAttempts: (maxWaitTime * 0.3) / 50, // Use remaining 30% of time
        checkInterval: 50,
        container
      });
    }
    
    console.log(`✅ Complete readiness achieved for ${bookId}${targetId ? ` (target: ${targetId})` : ''}`);
    
  } catch (error) {
    console.error(`❌ Complete readiness failed for ${bookId}:`, error);
    throw error;
  }
}

export { isElementFullyRendered };