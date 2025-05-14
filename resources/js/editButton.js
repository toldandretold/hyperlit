// reader‑edit.js

import {
  startObserving,
  stopObserving,
  addPasteListener,
  initTitleSync,
} from "./divEditor.js";
import { book } from "./app.js";
import { incrementPendingOperations, decrementPendingOperations } from './operationState.js';
import { NodeIdManager } from './IDmanager.js';

window.NodeIdManager = NodeIdManager;



const editBtn     = document.getElementById("editButton");
const editableDiv = document.getElementById(book);

// Detect “edit” from URL
const params   = new URLSearchParams(location.search);
const isEditQ  = params.get("edit") === "1";
const isEditP  = location.pathname.endsWith("/edit");
const shouldAutoEdit = isEditQ || isEditP;

// State flags
window.isEditing = false;

// Turn on all edit functionality
// Turn on all edit functionality
async function enableEditMode() {
  console.log("🔔 enableEditMode() called, shouldAutoEdit=", shouldAutoEdit);
  if (window.isEditing) return;
  if (!editableDiv) {
    console.error(`no #${book} div`);
    return;
  }

  // As soon as you enter edit mode:
  incrementPendingOperations();
  
  try {
    // Initialize the ID manager first, before making content editable
    console.log("Initializing NodeIdManager...");
    try {
      NodeIdManager.init();
      console.log("NodeIdManager initialized with", NodeIdManager.usedIds.size, "IDs");
      
      // Log some sample IDs to verify it's working
      if (NodeIdManager.usedIds.size > 0) {
        console.log("Sample IDs:", Array.from(NodeIdManager.usedIds).slice(0, 5));
      }
    } catch (error) {
      console.error("Error initializing NodeIdManager:", error);
    }
    
    // Check for and fix any duplicate IDs before starting edit mode
    const duplicatesFixed = NodeIdManager.fixDuplicates();
    if (duplicatesFixed > 0) {
      console.log(`Fixed ${duplicatesFixed} duplicate IDs during initialization`);
    }
    
    // Now make the content editable
    window.isEditing = true;
    editBtn.classList.add("inverted");
    editableDiv.contentEditable = "true";
    editableDiv.focus();

    // Start your mutation observer and hypercite/paste hooks
    startObserving(editableDiv);
    addPasteListener(editableDiv);

    // Wire up title sync
    initTitleSync(book);
    
    // Run an initial normalization on each chunk
    document.querySelectorAll('.chunk').forEach(chunk => {
      NodeIdManager.normalizeContainer(chunk);
    });
    
    console.log("Edit mode enabled with NodeIdManager initialized");
  } catch (error) {
    console.error("Error enabling edit mode:", error);
  } finally {
    // Always decrement the pending operations counter
    decrementPendingOperations();
  }
}


function disableEditMode() {
  if (!window.isEditing) return;
  window.isEditing = false;
  editBtn.classList.remove("inverted");
  editableDiv.contentEditable = "false";
  stopObserving();
  
  // Safely clear NodeIdManager if it exists
  if (window.NodeIdManager && typeof NodeIdManager.usedIds !== 'undefined') {
    console.log("Clearing NodeIdManager cache");
    NodeIdManager.usedIds.clear();
  }
  
  console.log("Edit mode disabled");
}

// Add this at the end of reader-edit.js to verify the edit button is working
console.log("Edit button element:", editBtn);
if (editBtn) {
  editBtn.addEventListener("click", () => {
    console.log("Edit button clicked");
    if (window.isEditing) {
      disableEditMode();
    } else {
      enableEditMode();
    }
  });
  console.log("Edit button event listener attached");
}

// Also check if auto-edit is working
if (shouldAutoEdit) {
  console.log("Auto-edit detected, enabling edit mode");
  enableEditMode();
}

