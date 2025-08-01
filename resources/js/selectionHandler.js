// resources/js/selectionHandler.js

const hyperlightButtons = document.getElementById("hyperlight-buttons");
const originalParent = hyperlightButtons.parentElement;

/**
 * Removes the toolbar separator if it exists.
 */
function removeSeparator() {
  const separator = document.getElementById("hyperlight-separator");
  if (separator) {
    separator.remove();
  }
}

function isMobile() {
  return window.innerWidth <= 768;
}

function handleSelection() {
  if (window.activeContainer === "source-container") {
    return;
  }

  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  if (selectedText.length > 0) {
    const editToolbar = document.getElementById("edit-toolbar");

    if (isMobile()) {
      hyperlightButtons.style.top = "";
      hyperlightButtons.style.left = "";
      hyperlightButtons.style.position = "";

      if (window.isEditing && editToolbar) {
        hyperlightButtons.classList.remove("mobile-fixed-bottom");

        if (hyperlightButtons.parentElement !== editToolbar) {
          // --- THIS IS THE CORRECTED LOGIC ---
          // 1. Create the separator
          const separator = document.createElement("span");
          separator.id = "hyperlight-separator";
          separator.className = "toolbar-separator";

          // 2. Insert it as the FIRST CHILD of the buttons container
          hyperlightButtons.insertBefore(
            separator,
            hyperlightButtons.firstChild,
          );
          // --- END OF CORRECTION ---

          // 3. Add the entire group to the toolbar
          editToolbar.appendChild(hyperlightButtons);
        }
        // --- END OF NEW LOGIC ---
      } else {
        // When not in edit mode, ensure the separator is gone
        removeSeparator();
        hyperlightButtons.classList.add("mobile-fixed-bottom");
        if (hyperlightButtons.parentElement !== originalParent) {
          originalParent.appendChild(hyperlightButtons);
        }
      }
      hyperlightButtons.style.display = "flex";
    } else {
      // When on desktop, ensure the separator is gone
      removeSeparator();
      hyperlightButtons.classList.remove("mobile-fixed-bottom");
      if (hyperlightButtons.parentElement !== originalParent) {
        originalParent.appendChild(hyperlightButtons);
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      hyperlightButtons.style.display = "flex";
      const offset = 100;
      if (rect.bottom + offset > window.innerHeight) {
        hyperlightButtons.style.top = `${rect.top + window.scrollY - offset}px`;
      } else {
        hyperlightButtons.style.top = `${
          rect.bottom + window.scrollY + 10
        }px`;
      }
      hyperlightButtons.style.left = `${rect.left + window.scrollX}px`;
    }

    const highlights = document.querySelectorAll("mark.user-highlight");
    let isOverlapping = false;
    highlights.forEach(function (highlight) {
      if (selectedText.includes(highlight.textContent.trim())) {
        isOverlapping = true;
      }
    });
    document.getElementById("delete-hyperlight").style.display = isOverlapping
      ? "block"
      : "none";
  } else {
    // When no text is selected, hide everything and remove the separator
    removeSeparator();
    hyperlightButtons.style.display = "none";
    hyperlightButtons.classList.remove("mobile-fixed-bottom");
    document.getElementById("delete-hyperlight").style.display = "none";
  }
}

export function initializeSelectionHandler() {
  document.addEventListener("selectionchange", handleSelection);
  console.log("✅ Selection Handler Initialized");
}