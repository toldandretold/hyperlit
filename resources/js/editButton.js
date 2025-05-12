// reader‑edit.js

import {
  startObserving,
  stopObserving,
  addPasteListener,
  initTitleSync,
} from "./divEditor.js";
import { book } from "./app.js";
import { incrementPendingOperations, decrementPendingOperations } from './operationState.js';






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

    // As soon as you enter edit mode:
  incrementPendingOperations();
  // Immediately clear it so no spinner remains:
  decrementPendingOperations();

  window.isEditing = true;
  editBtn.classList.add("inverted");
  editableDiv.contentEditable = "true";
  editableDiv.focus();

  // Start your mutation observer and hypercite/paste hooks
  startObserving(editableDiv);
  addPasteListener(editableDiv);

  // Wire up title sync
  initTitleSync(book);



  console.log("Edit mode enabled");
}

// Turn off edit mode
function disableEditMode() {
  if (!window.isEditing) return;
  window.isEditing = false;
  editBtn.classList.remove("inverted");
  editableDiv.contentEditable = "false";
  stopObserving();
  console.log("Edit mode disabled");
}

// Button toggles edit mode
editBtn.addEventListener("click", () => {
  if (window.isEditing) disableEditMode();
  else enableEditMode();
});

// On DOM ready, auto‑enable if URL says “edit”
document.addEventListener("DOMContentLoaded", () => {
  if (shouldAutoEdit) {
    console.log("Auto‑entering edit mode");
    enableEditMode();
  }
});


