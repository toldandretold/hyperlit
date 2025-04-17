import { book } from "./app.js";
import { startObserving, stopObserving, addPasteListener } from "./divEditor.js";

// Global flag to track edit mode.
window.isEditing = false;

// Save original read position when clicking "edit" button and toggle contentEditable.
document.getElementById("editButton").addEventListener("click", function () {
  // Save the current read position by finding the element at the center.
  const elementInView = document.elementFromPoint(
    window.innerWidth / 2,
    window.innerHeight / 2
  );
  const domPath = getDomPath(elementInView);

  // Save and log the original path for returning from edit mode.
  localStorage.setItem("originalReadPath", domPath);
  console.log("Saved originalReadPath on edit:", domPath);

  // Toggle contentEditable on the target element.
  // Ensure that 'book' variable contains the ID of the <div> you want to edit.
  const editableDiv = document.getElementById(book);

  this.classList.toggle("inverted");

  if (editableDiv) {
    if (editableDiv.contentEditable === "true") {
      // Disable editing and stop the observer.
      editableDiv.contentEditable = "false";
      stopObserving();
      window.isEditing = false; // Set editing flag to false
      console.log("Edit mode disabled.");
    } else {
      // Enable editing, focus the div, and start the observer.
      editableDiv.contentEditable = "true";
      editableDiv.focus();
      window.isEditing = true; // Set editing flag to true
      startObserving(editableDiv);
      addPasteListener(editableDiv);
      console.log("Edit mode enabled.");
    }
  } else {
    console.error(`Element with ID "${book}" not found.`);
  }
});

// Function to get the full DOM path of the element in view.
function getDomPath(element) {
  let path = [];
  while (element && element.nodeType === Node.ELEMENT_NODE) {
    let selector = element.nodeName.toLowerCase();
    if (element.id) {
      selector += `#${element.id}`;
      path.unshift(selector);
      break;
    } else {
      let sibling = element;
      let siblingIndex = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.nodeName.toLowerCase() === selector) siblingIndex++;
      }
      selector += `:nth-of-type(${siblingIndex})`;
    }
    path.unshift(selector);
    element = element.parentNode;
  }
  return path.join(" > ");
}

// Save position on refresh or navigation away.
window.addEventListener('beforeunload', function () {
  const elementInView = document.elementFromPoint(
    window.innerWidth / 2,
    window.innerHeight / 2
  );
  const domPath = getDomPath(elementInView);
  localStorage.setItem('originalReadPath', domPath);
  console.log("Updated originalReadPath on refresh:", domPath);
});
