// chunkManager.js

/**
 * ChunkManager - Tracks node counts in chunks and handles splitting when needed
 */
export class ChunkManager {
  constructor(options = {}) {
    // Configuration
    this.maxNodesPerChunk = options.maxNodesPerChunk || 100;
    this.splitThreshold = options.splitThreshold || 200;
    this.onChunkSplit = options.onChunkSplit || (() => console.log('Chunk split occurred'));
    
    // State tracking
    this.chunkCounts = new Map(); // Maps chunkId -> node count
    this.observers = new Map();   // Maps chunkId -> MutationObserver
  }

  /**
   * Start tracking a chunk
   * @param {HTMLElement} chunkElement - The chunk container element
   * @param {string} chunkId - Unique identifier for the chunk
   */
  trackChunk(chunkElement, chunkId) {
    if (!chunkElement || !chunkId) {
      console.error('Invalid chunk element or ID provided');
      return;
    }

    // Stop tracking if already tracking this chunk
    if (this.observers.has(chunkId)) {
      this.stopTracking(chunkId);
    }

    // Initialize count for this chunk
    const initialCount = this.countNodes(chunkElement);
    this.chunkCounts.set(chunkId, initialCount);
    
    console.log(`Started tracking chunk ${chunkId} with initial count: ${initialCount}`);

    // Create and start observer
    const observer = this.createObserver(chunkElement, chunkId);
    this.observers.set(chunkId, observer);
  }

  /**
   * Stop tracking a specific chunk
   * @param {string} chunkId - ID of the chunk to stop tracking
   */
  stopTracking(chunkId) {
    const observer = this.observers.get(chunkId);
    if (observer) {
      observer.disconnect();
      this.observers.delete(chunkId);
      this.chunkCounts.delete(chunkId);
      console.log(`Stopped tracking chunk ${chunkId}`);
    }
  }

  /**
   * Stop tracking all chunks
   */
  stopTrackingAll() {
    for (const chunkId of this.observers.keys()) {
      this.stopTracking(chunkId);
    }
    console.log('Stopped tracking all chunks');
  }

  /**
   * Count the number of top-level nodes in a chunk
   * @param {HTMLElement} chunkElement - The chunk container
   * @returns {number} - Number of top-level nodes
   */
  countNodes(chunkElement) {
    // Count only element nodes that have IDs matching our pattern
    return Array.from(chunkElement.children).filter(
      node => node.nodeType === Node.ELEMENT_NODE && 
              node.id && 
              /^\d+(\.\d+)?$/.test(node.id)
    ).length;
  }

  /**
   * Create a mutation observer for a chunk
   * @param {HTMLElement} chunkElement - The chunk container
   * @param {string} chunkId - ID of the chunk
   * @returns {MutationObserver} - The configured observer
   */
  createObserver(chunkElement, chunkId) {
    const observer = new MutationObserver(mutations => {
      let addedNodes = 0;
      let removedNodes = 0;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Count added nodes that match our pattern
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && 
                node.id && 
                /^\d+(\.\d+)?$/.test(node.id)) {
              addedNodes++;
            }
          });

          // Count removed nodes that match our pattern
          mutation.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && 
                node.id && 
                /^\d+(\.\d+)?$/.test(node.id)) {
              removedNodes++;
            }
          });
        }
      }

      // Update count if there were changes
      if (addedNodes > 0 || removedNodes > 0) {
        const currentCount = this.chunkCounts.get(chunkId) || 0;
        const newCount = currentCount + addedNodes - removedNodes;
        this.chunkCounts.set(chunkId, newCount);
        
        console.log(`Chunk ${chunkId} count updated: ${currentCount} → ${newCount} (added: ${addedNodes}, removed: ${removedNodes})`);
        
        // Check if we need to split the chunk
        if (newCount >= this.splitThreshold) {
          this.splitChunk(chunkElement, chunkId);
        }
      }
    });

    // Start observing
    observer.observe(chunkElement, {
      childList: true,
      subtree: false // We only care about top-level nodes
    });

    return observer;
  }

  /**
   * Split a chunk when it exceeds the threshold
   * @param {HTMLElement} chunkElement - The chunk container
   * @param {string} chunkId - ID of the chunk
   */
  async splitChunk(chunkElement, chunkId) {
    console.log(`Splitting chunk ${chunkId} - exceeded threshold of ${this.splitThreshold} nodes`);
    
    // Get all nodes in the chunk
    const nodes = Array.from(chunkElement.children).filter(
      node => node.nodeType === Node.ELEMENT_NODE && 
              node.id && 
              /^\d+(\.\d+)?$/.test(node.id)
    );
    
    // Sort nodes by ID (numeric order)
    nodes.sort((a, b) => {
      const idA = parseFloat(a.id);
      const idB = parseFloat(b.id);
      return idA - idB;
    });
    
    // Keep the newest nodes in the current chunk, move oldest to new chunk
    const nodesToMove = nodes.slice(0, this.maxNodesPerChunk);
    const nodesToKeep = nodes.slice(this.maxNodesPerChunk);
    
    // Generate new chunk ID (typically the current chunk ID + 1)
    const newChunkId = this.generateNewChunkId(chunkId);
    
    // Call the onChunkSplit callback with the necessary information
    await this.onChunkSplit({
      originalChunkId: chunkId,
      newChunkId: newChunkId,
      nodesToMove: nodesToMove,
      nodesToKeep: nodesToKeep
    });
    
    // Update the count for the current chunk
    this.chunkCounts.set(chunkId, nodesToKeep.length);
    
    console.log(`Chunk split complete. ${chunkId} now has ${nodesToKeep.length} nodes, new chunk ${newChunkId} has ${nodesToMove.length} nodes`);
  }

  /**
   * Generate a new chunk ID based on the current one
   * @param {string} currentChunkId - The current chunk ID
   * @returns {string} - A new chunk ID
   */
  generateNewChunkId(currentChunkId) {
    // Simple implementation: increment the chunk number
    // You might want to replace this with your own logic
    const match = currentChunkId.match(/chunk-(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      return `chunk-${num + 1}`;
    }
    return `chunk-${Date.now()}`;
  }

  /**
   * Get the current count for a chunk
   * @param {string} chunkId - ID of the chunk
   * @returns {number} - Current node count
   */
  getCount(chunkId) {
    return this.chunkCounts.get(chunkId) || 0;
  }

  /**
   * Force a recount of nodes in a chunk
   * @param {HTMLElement} chunkElement - The chunk container
   * @param {string} chunkId - ID of the chunk
   * @returns {number} - Updated count
   */
  forceRecount(chunkElement, chunkId) {
    const count = this.countNodes(chunkElement);
    this.chunkCounts.set(chunkId, count);
    console.log(`Forced recount of chunk ${chunkId}: ${count} nodes`);
    return count;
  }
}


