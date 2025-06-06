// reader‑edit.js

import {
  startObserving,
  stopObserving,
  addPasteListener,
  initTitleSync,
} from "./divEditor.js";
import { book } from "./app.js";
import { incrementPendingOperations, decrementPendingOperations } from './operationState.js';
//import { NodeIdManager } from './IDmanager.js';

//window.NodeIdManager = NodeIdManager;



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
async function enableEditMode() {
  console.log("🔔 enableEditMode() called, shouldAutoEdit=", shouldAutoEdit);
  if (window.isEditing) return;
  if (!editableDiv) {
    console.error(`no #${book} div`);
    return;
  }

  incrementPendingOperations();
  
  try {
    window.isEditing = true;
    editBtn.classList.add("inverted");
    editableDiv.contentEditable = "true";
    
    // Check if there's already a selection
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      // Create a selection at the current scroll position
      const range = document.createRange();
      const walker = document.createTreeWalker(
        editableDiv,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      
      let textNode = walker.nextNode();
      if (textNode) {
        range.setStart(textNode, 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    
    editableDiv.focus();

    startObserving(editableDiv);
    addPasteListener(editableDiv);
    initTitleSync(book);
    
    console.log("Edit mode enabled");
  } catch (error) {
    console.error("Error enabling edit mode:", error);
  } finally {
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

