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
  if (element.tagName === 'MARK' && element.id.startsWith('HL_')) {
    // Highlight should have proper classes applied
    return element.className && element.className.length > 0;
  }
  
  if (element.tagName === 'U' && element.id.startsWith('hypercite_')) {
    // Hypercite should have relationship status class
    return element.classList.contains('single') || 
           element.classList.contains('couple') || 
           element.classList.contains('poly');
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
      const element = container.querySelector(`#${CSS.escape(targetId)}`);
      
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
        }, 100); // Wait 100ms after last mutation
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

export { isElementFullyRendered };