// reader-edit.js

import { startObserving, stopObserving, addPasteListener } from "./divEditor.js";
import { book } from "./app.js";

window.isEditing = false;

const editBtn = document.getElementById("editButton");
const editableDiv = document.getElementById(book);

function enableEditMode() {
  if (!editableDiv) return console.error(`no #${book} div`);
  // visually toggle the button
  editBtn.classList.add("inverted");
  // turn on contentEditable
  editableDiv.contentEditable = "true";
  editableDiv.focus();
  // start your mutation observer / paste listener
  window.isEditing = true;
  startObserving(editableDiv);
  addPasteListener(editableDiv);
  console.log("Edit mode enabled");
}

function disableEditMode() {
  if (!editableDiv) return;
  editBtn.classList.remove("inverted");
  editableDiv.contentEditable = "false";
  stopObserving();
  window.isEditing = false;
  console.log("Edit mode disabled");
}

// wire up the click to toggle
editBtn.addEventListener("click", () => {
  // save scroll/DOM position if you want
  // … getDomPath logic …
  if (window.isEditing) {
    disableEditMode();
  } else {
    enableEditMode();
  }
});

// on load, if we came in with ?edit=1 or /edit, enable immediately
document.addEventListener("DOMContentLoaded", () => {
  if (window.editMode) {
    enableEditMode();
  }
});
