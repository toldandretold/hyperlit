import { updateIndexedDBRecordForNormalization, updateIndexedDBRecord } from './cache-indexedDB.js';

// Create a singleton ID manager
export const NodeIdManager = {
  // Track all IDs currently in use
  usedIds: new Set(),
  
  // Initialize by scanning the document
  init() {
    this.usedIds.clear();
    document.querySelectorAll('[id]').forEach(el => {
      this.usedIds.add(el.id);
    });
    console.log(`ID Manager initialized with ${this.usedIds.size} IDs`);
  },
  
  // Register a new ID
  register(id) {
    this.usedIds.add(id);
    return id;
  },
  
  // Unregister an ID (when element is removed)
  unregister(id) {
    this.usedIds.delete(id);
  },
  
  // Check if ID exists
  exists(id) {
    return this.usedIds.has(id) || document.getElementById(id) !== null;
  },
  
  // Generate next ID after a reference node
  getNextId(referenceId) {
    // Parse the reference ID
    const match = referenceId.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return this.generateUniqueId();
    
    const base = match[1];
    const suffix = match[2] ? parseInt(match[2], 10) : 0;
    
    // Try incrementing the suffix
    let newSuffix = suffix + 1;
    let newId = suffix === 0 ? `${base}.${newSuffix}` : `${base}.${newSuffix}`;
    
    // If that ID exists, keep incrementing until we find an available one
    while (this.exists(newId)) {
      newSuffix++;
      newId = `${base}.${newSuffix}`;
    }
    
    return this.register(newId);
  },
  
  // Generate an ID between two existing IDs
 // Replace the getIntermediateId method in NodeIdManager with this:
  getIntermediateId(beforeId, afterId) {
    // If either ID is missing, delegate to other methods
    if (!beforeId) return this.getIdBefore(afterId);
    if (!afterId) return this.getNextId(beforeId);
    
    // Parse both IDs
    const beforeMatch = beforeId.match(/^(\d+)(?:\.(\d+))?$/);
    const afterMatch = afterId.match(/^(\d+)(?:\.(\d+))?$/);
    
    // If either doesn't match the pattern, use fallback
    if (!beforeMatch || !afterMatch) return this.generateUniqueId();
    
    const beforeBase = beforeMatch[1];
    const afterBase = afterMatch[1];
    
    // If bases don't match, use the before base
    if (beforeBase !== afterBase) return this.getNextId(beforeId);
    
    const beforeSuffix = beforeMatch[2] ? parseInt(beforeMatch[2], 10) : 0;
    const afterSuffix = afterMatch[2] ? parseInt(afterMatch[2], 10) : 0;
    
    // Special case: if beforeId is a base (like "1") and afterId has a suffix (like "1.1")
    if (beforeSuffix === 0 && afterSuffix > 0) {
      // Generate an ID with a suffix of 0.5
      return this.register(`${beforeBase}.05`);
    }
    
    // Calculate a suffix between the two
    let newSuffix;
    if (afterSuffix - beforeSuffix > 1) {
      // If there's room between, use the middle
      newSuffix = Math.floor((beforeSuffix + afterSuffix) / 2);
    } else {
      // Otherwise, use a value halfway between
      newSuffix = beforeSuffix + 0.5;
    }
    
    let newId = `${beforeBase}.${newSuffix}`;
    
    // Ensure uniqueness
    if (this.exists(newId)) {
      // If already exists, fall back to next ID
      return this.getNextId(beforeId);
    }
    
    return this.register(newId);
  },
  
  // Generate an ID before an existing ID
  getIdBefore(afterId) {
    const match = afterId.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return this.generateUniqueId();
    
    const base = match[1];
    const suffix = match[2] ? parseInt(match[2], 10) : 0;
    
    let newSuffix;
    if (suffix > 1) {
      // If suffix > 1, we can go lower
      newSuffix = suffix - 1;
    } else if (suffix === 1) {
      // If suffix is 1, use 0.5
      newSuffix = 0.5;
    } else {
      // If no suffix, use .1
      newSuffix = 1;
    }
    
    let newId = `${base}.${newSuffix}`;
    
    // Ensure uniqueness
    if (this.exists(newId)) {
      // Try decrementing until we find an available ID
      let attempts = 0;
      while (this.exists(newId) && attempts < 100) {
        newSuffix = newSuffix - 0.1;
        newId = `${base}.${newSuffix.toFixed(1)}`;
        attempts++;
      }
      
      if (attempts >= 100) {
        return this.generateUniqueId();
      }
    }
    
    return this.register(newId);
  },
  
  // Generate a completely unique ID as fallback
  generateUniqueId() {
    const id = "node_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    return this.register(id);
  },
  
  // Fix duplicate IDs in the document
  fixDuplicates() {
    // Track IDs we've seen
    const seenIds = new Set();
    const duplicates = [];
    
    // Find all elements with IDs
    document.querySelectorAll('[id]').forEach(el => {
      if (seenIds.has(el.id)) {
        duplicates.push(el);
      } else {
        seenIds.add(el.id);
      }
    });
    
    console.log(`Found ${duplicates.length} elements with duplicate IDs`);
    
    // Fix each duplicate
    duplicates.forEach(el => {
      const oldId = el.id;
      
      // Find the element's position
      const parent = el.parentElement;
      if (!parent) return;
      
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(el);
      
      let newId;
      if (index > 0) {
        // If there's an element before this one, generate ID after it
        const prevSibling = siblings[index - 1];
        if (prevSibling.id && /^\d+(\.\d+)?$/.test(prevSibling.id)) {
          newId = this.getNextId(prevSibling.id);
        } else {
          newId = this.generateUniqueId();
        }
      } else {
        // If this is the first element, generate a unique ID
        newId = this.generateUniqueId();
      }
      
      console.log(`Fixing duplicate ID: ${oldId} → ${newId}`);
      el.id = newId;
      
      // Update in IndexedDB
      updateIndexedDBRecordForNormalization(oldId, newId, el.outerHTML);
    });
    
    return duplicates.length;
  },
  
  // Normalize all IDs in a container to ensure proper sequence
 normalizeContainer(container, startingElement = null) {
  console.log("Starting normalization with:", {
    container,
    startingElement,
    startingElementId: startingElement ? startingElement.id : null
  });
  
  if (!container) return 0;
  
  // Get all elements with IDs
  const elements = Array.from(container.querySelectorAll('[id]'))
    .filter(el => !isNaN(parseFloat(el.id)));
  
  // Sort by DOM position
  elements.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  
  let changesCount = 0;
  let startIndex = 0;
  let nextId;
  
  // If a starting element is provided, find its index and determine the next ID
  if (startingElement) {
    startIndex = elements.findIndex(el => el === startingElement || 
                                     el.compareDocumentPosition(startingElement) & 
                                     Node.DOCUMENT_POSITION_CONTAINS);
    
    if (startIndex > 0) {
      // Get the ID of the element before the starting point
      const prevId = parseFloat(elements[startIndex - 1].id);
      nextId = prevId + 1;
    } else {
      startIndex = 0;
      nextId = 1; // If starting from the beginning, start with ID 1
    }
  } else {
    // If no starting element, find the highest existing ID and continue from there
    const highestId = elements.reduce((max, el) => 
      Math.max(max, parseFloat(el.id)), 0);
    nextId = highestId + 1;
  }
  
  // Assign sequential IDs only from the starting point
  for (let i = startIndex; i < elements.length; i++) {
    const expectedId = nextId.toString();
    if (elements[i].id !== expectedId) {
      const oldId = elements[i].id;
      elements[i].id = expectedId;
      // Update your registry and IndexedDB here
      this.register(expectedId);
      this.unregister(oldId);
      updateIndexedDBRecordForNormalization(oldId, expectedId, elements[i].outerHTML);
      changesCount++;
    }
    nextId++;
  }
  
  console.log(`Normalized ${changesCount} IDs in container from index ${startIndex}`);
  return changesCount;
},


};


