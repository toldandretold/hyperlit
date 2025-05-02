// Command Queue System for Editor Operations
class EditorCommandQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.history = []; // For undo functionality
    this.redoStack = []; // For redo functionality
  }

  // Add a command to the queue
  enqueue(command) {
    this.queue.push(command);
    this.processQueue();
    return command.id; // Return ID for potential reference
  }

  // Process the next command in the queue
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    
    this.isProcessing = true;
    showSpinner(); // Visual indicator that work is happening
    
    try {
      const command = this.queue.shift();
      console.log(`Processing command: ${command.type}`, command);
      
      // Execute the command
      await command.execute();
      
      // Add to history for undo
      this.history.push(command);
      
      // Clear redo stack when new commands are executed
      if (command.type !== 'redo') {
        this.redoStack = [];
      }
      
      showTick(); // Show success indicator
    } catch (error) {
      console.error("Error processing command:", error);
      // Could implement retry logic here
    } finally {
      this.isProcessing = false;
      
      // Continue processing if there are more commands
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }
  
  // Undo the last command
  async undo() {
    if (this.history.length === 0) return false;
    
    const command = this.history.pop();
    await command.undo();
    
    // Add to redo stack
    this.redoStack.push(command);
    return true;
  }
  
  // Redo the last undone command
  async redo() {
    if (this.redoStack.length === 0) return false;
    
    const command = this.redoStack.pop();
    this.enqueue({
      ...command,
      type: 'redo'
    });
    return true;
  }
}

// Command factory to create different types of commands
const CommandFactory = {
  createAddNodeCommand(node) {
    return {
      id: `add_${Date.now()}`,
      type: 'add',
      node,
      nodeId: node.id,
      html: node.outerHTML,
      
      execute: async function() {
        return updateIndexedDBRecord({
          id: this.nodeId,
          html: this.html,
          action: "add"
        });
      },
      
      undo: async function() {
        return deleteIndexedDBRecord(this.nodeId);
      }
    };
  },
  
  createUpdateNodeCommand(node, previousHtml) {
    return {
      id: `update_${Date.now()}`,
      type: 'update',
      node,
      nodeId: node.id,
      newHtml: node.outerHTML,
      previousHtml,
      
      execute: async function() {
        return updateIndexedDBRecord({
          id: this.nodeId,
          html: this.newHtml,
          action: "update"
        });
      },
      
      undo: async function() {
        // Restore previous HTML
        const element = document.getElementById(this.nodeId);
        if (element) {
          element.outerHTML = this.previousHtml;
        }
        return updateIndexedDBRecord({
          id: this.nodeId,
          html: this.previousHtml,
          action: "update"
        });
      }
    };
  },
  
  createDeleteNodeCommand(node) {
    return {
      id: `delete_${Date.now()}`,
      type: 'delete',
      nodeId: node.id,
      html: node.outerHTML,
      
      execute: async function() {
        return deleteIndexedDBRecord(this.nodeId);
      },
      
      undo: async function() {
        // Need to reinsert the node in the DOM
        // This would require tracking the node's position
        return updateIndexedDBRecord({
          id: this.nodeId,
          html: this.html,
          action: "add"
        });
      }
    };
  },
  
  createNormalizeCommand(changes) {
    return {
      id: `normalize_${Date.now()}`,
      type: 'normalize',
      changes, // Array of {oldId, newId, html}
      
      execute: async function() {
        for (const change of this.changes) {
          await updateIndexedDBRecordForNormalization(
            change.oldId, 
            change.newId, 
            change.html
          );
        }
        return true;
      },
      
      undo: async function() {
        // Reverting normalization is complex
        // Would need to store the entire state before normalization
        console.warn("Undo for normalization not implemented");
        return false;
      }
    };
  }
};

// Create a global instance
const editorCommands = new EditorCommandQueue();


function observeEditableDiv(editableDiv) {
  const originalContent = new Map();
  editableDiv.querySelectorAll("[id]").forEach((node) => {
    originalContent.set(node.id, node.innerHTML);
  });

  const observer = new MutationObserver((mutations) => {
    // Indicate that processing is starting
    showSpinner();
    documentChanged = true;

    mutations.forEach((mutation) => {
      // Process additions/removals first
      if (mutation.type === "childList") {
        // Process newly added nodes
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            ensureNodeHasValidId(node);
            // Create and enqueue an add command
            editorCommands.enqueue(
              CommandFactory.createAddNodeCommand(node)
            );
            addedNodes.add(node);
          }
        });

        // Process removed nodes
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.id) {
            // Create and enqueue a delete command
            editorCommands.enqueue(
              CommandFactory.createDeleteNodeCommand(node)
            );
            removedNodeIds.add(node.id);
            originalContent.delete(node.id);
          }
        });
      } 
      // Handle character data changes
      else if (mutation.type === "characterData") {
        const parent = mutation.target.parentNode;
        if (parent && parent.id) {
          if (parent.innerHTML !== originalContent.get(parent.id)) {
            // Create and enqueue an update command
            editorCommands.enqueue(
              CommandFactory.createUpdateNodeCommand(
                parent, 
                originalContent.get(parent.id)
              )
            );
            modifiedNodes.add(parent.id);
            originalContent.set(parent.id, parent.innerHTML);
          }
        }
      }
    });

    // Trigger the debounced normalization
    if (editableDiv) {
      debouncedNormalize(editableDiv);
    }
  });

  // Rest of your observer setup...
}

async function normalizeNodeIds(container) {
  // ... existing code to detect if normalization is needed ...

  if (!needsNormalization) {
    console.log("IDs are already in correct order, skipping normalization");
    return false;
  }

  // ... existing code to build idMap ...

  // Collect changes but don't apply them yet
  const changes = [];
  for (const [oldId, newId] of Object.entries(idMap)) {
    const node = document.getElementById(oldId);
    if (node && oldId !== newId) {
      changes.push({ 
        node, 
        oldId, 
        newId,
        html: node.outerHTML.replace(oldId, newId)
      });
    }
  }

  // Apply changes to DOM
  for (const { node, oldId, newId, html } of changes) {
    console.log(`Normalizing: Changing node ID from ${oldId} to ${newId}`);
    node.id = newId;
  }

  // Create and enqueue a normalize command
  editorCommands.enqueue(
    CommandFactory.createNormalizeCommand(changes)
  );

  return changes.length > 0;
}
