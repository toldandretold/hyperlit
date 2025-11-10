import {
  startObserving,
  stopObserving
} from "../divEditor.js";
import { book } from "../app.js";
import { incrementPendingOperations, decrementPendingOperations } from '../utilities/operationState.js';
import { addPasteListener } from '../paste';
import { getCurrentUser, canUserEditBook } from "../utilities/auth.js";
import { getLibraryObjectFromIndexedDB } from '../indexedDB.js';
import { initEditToolbar, getEditToolbar } from '../editToolbar';
import userManager from "./userContainer.js";
import { pendingFirstChunkLoadedPromise } from '../initializePage.js';



// Detect "edit" from URL
const params   = new URLSearchParams(location.search);
const isEditQ  = params.get("edit") === "1";
const isEditP  = location.pathname.endsWith("/edit");
const shouldAutoEdit = isEditQ || isEditP;


// State flags
window.isEditing = false;

// Add this at the top with your other variables
let editModeCheckInProgress = false;

export function resetEditModeState() {
    console.log(`🧹 Resetting all edit mode state. Was isEditing=${window.isEditing}, was checkInProgress=${editModeCheckInProgress}`);
    window.isEditing = false;
    editModeCheckInProgress = false;
}

export function handleAutoEdit() {
  const urlParams = new URLSearchParams(window.location.search);
  const isEditQ = urlParams.get("edit") === "1"; // ✅ Match the top logic
  const isEditP = location.pathname.endsWith("/edit");
  const shouldAutoEdit = isEditQ || isEditP;
  const targetElementId = urlParams.get('target');

  if (shouldAutoEdit) {
    console.log("Auto-edit detected, enabling edit mode");
    enableEditMode(targetElementId);
  }
}


// Add this function to handle edit mode cancellation without reload
function handleEditModeCancel() {
  editModeCheckInProgress = false;
  disableEditMode();
  
  // Clean up ALL edit-related URL parameters
  const currentUrl = new URL(window.location);
  currentUrl.searchParams.delete('edit');
  currentUrl.searchParams.delete('target');
  
  if (currentUrl.pathname.endsWith('/edit')) {
    currentUrl.pathname = currentUrl.pathname.replace(/\/edit$/, '');
  }
  
  window.history.pushState({}, '', currentUrl.toString());
}

// Add this helper function to get the saved scroll position
function getSavedScrollElementId(bookId) {
  const storageKey = `scrollPosition_${bookId}`;
  try {
    const scrollData = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (scrollData) {
      const parsed = JSON.parse(scrollData);
      return parsed.elementId;
    }
  } catch (error) {
    console.warn("Error parsing saved scroll position:", error);
  }
  return null;
}

// Add this helper function to place cursor at end of specific element
// Add this helper function to place cursor at end of specific element
function placeCursorAtEndOfElement(elementId) {
  console.log(`Attempting to place cursor at element with id="${elementId}"`);
  
  const targetElement = document.getElementById(elementId);
  console.log("Target element found:", targetElement);
  console.log("Target element content:", targetElement?.textContent);
  
  if (!targetElement) {
    console.warn(`Element with id="${elementId}" not found`);
    return false;
  }
  
  try {
    // Focus the element first
    targetElement.focus();
    console.log("Element focused");
    
    // Create range and selection
    const range = document.createRange();
    const selection = window.getSelection();
    
    // Select all content in the element
    range.selectNodeContents(targetElement);
    // Collapse to end (cursor at end of content)
    range.collapse(false);
    
    // Apply the selection
    selection.removeAllRanges();
    selection.addRange(range);
    
    console.log(`✅ Cursor placed at end of element with id="${elementId}"`);
    console.log("Selection after placement:", selection.toString());
    return true;
  } catch (error) {
    console.error(`❌ Error placing cursor in element ${elementId}:`, error);
    return false;
  }
}
// Add this helper function to find the first element with an ID
function getFirstElementWithId(container) {
  const elementsWithId = container.querySelectorAll("[id]");
  if (elementsWithId.length > 0) {
    return elementsWithId[0].id;
  }
  return null;
}

function doesContentExceedViewport(container) {
  const containerRect = container.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  
  // Check if container bottom is beyond viewport
  return containerRect.bottom > viewportHeight;
}

// Add this helper function to find the last element with meaningful content
function getLastContentElement(container) {
  const elementsWithId = container.querySelectorAll("[id]");
  if (elementsWithId.length === 0) return null;
  
  // Filter out elements that are likely empty or just structural
  const contentElements = Array.from(elementsWithId).filter(el => {
    const text = el.textContent?.trim();
    return text && text.length > 0;
  });
  
  if (contentElements.length === 0) return null;
  
  // Return the last element with content
  return contentElements[contentElements.length - 1].id;
}

// PASTE THIS ENTIRE FUNCTION INTO resources/js/editButton.js

export async function enableEditMode(targetElementId = null, isNewBook = false) {
  const editBtn = document.getElementById("editButton");
  const editableDiv = document.getElementById(book);

  console.log("🔔 enableEditMode() called...");

  if (window.isEditing || editModeCheckInProgress) {
    console.log("Edit mode already active or check in progress, returning");
    return;
  }

  if (!editableDiv) {
    console.error(`no #${book} div`);
    return;
  }

  editModeCheckInProgress = true;


  // This block for permission checking is perfect.
  if (window.pendingBookSyncPromise) {
    try {
      await window.pendingBookSyncPromise;
      console.log(
        "✅ Pending book sync complete. Proceeding with permission check."
      );
    } catch (e) {
      console.error("Sync failed, cannot enable edit mode.", e);
      showCustomAlert(
        "Sync In Progress",
        "The book is still syncing. Please try again in a moment.",
        { showReadButton: true }
      );
      editModeCheckInProgress = false;
      return;
    } finally {
      window.pendingBookSyncPromise = null;
    }
  }

  // =================================================================
  // THE SINGLE, CORRECT PERMISSION CHECK
  // =================================================================
  const canEdit = await canUserEditBook(book);

  // This block handles the case where the user does NOT have permission.
  if (!canEdit) {
    console.log("❌ User does not have permission to edit this book");
    
    const currentUser = await getCurrentUser();
    
    if (!currentUser) {
      // User not logged in - show login prompt
      userManager.setPostLoginAction(() => {
        // After successful login, simply try to enable edit mode again
        // This will trigger the permission check and show appropriate UI
        enableEditMode(targetElementId);
      });

      showCustomAlert(
        "Login to Edit",
        "You need to be logged in to your account to edit this book.",
        {
          showLoginButton: true,
          showReadButton: true,
        }
      );
    } else {
      // User is logged in but doesn't have permissions - replace with lock icon
      replaceEditButtonWithLock();
      console.log("🔒 User is logged in but doesn't have edit permissions - showing lock icon");
    }

    editModeCheckInProgress = false;
    return; // IMPORTANT: Stop the function here.
  }

  // =================================================================
  // If the code reaches this point, the user HAS permission.
  // The rest of the function will now execute correctly.
  // =================================================================

  incrementPendingOperations();

  try {
    console.log("⏳ Waiting for the first chunk of content to render...");
    await pendingFirstChunkLoadedPromise;
    console.log("✅ First chunk is ready. Proceeding to enable edit mode.");

    setTimeout(() => {
      try {
        console.log("🚀 Proceeding to enable edit mode after browser tick.");
        window.isEditing = true;
        if (editBtn) editBtn.classList.add("inverted");

        // Ensure perimeter buttons are visible in edit mode
        const bottomRightButtons = document.getElementById("bottom-right-buttons");
        if (bottomRightButtons) {
          bottomRightButtons.classList.remove("perimeter-hidden");
          console.log("👁️ Removed perimeter-hidden from bottom-right-buttons for edit mode");
        }

        enforceEditableState();

        editableDiv.contentEditable = "true";

        const toolbar = getEditToolbar();
        if (toolbar) {
          toolbar.setEditMode(true);
        }

        // ✅ ONLY call ensureMinimumDocumentStructure for new blank books
        if (isNewBook) {
          console.log("📝 New blank book: Ensuring minimum document structure...");
          import("../divEditor.js").then(({ ensureMinimumDocumentStructure }) => {
            ensureMinimumDocumentStructure();
          });
        }

        // =================================================================
        // YOUR CURSOR PLACEMENT LOGIC - INCLUDED AND IN THE CORRECT PLACE
        // =================================================================
        let cursorPlaced = false;
        if (targetElementId) {
          cursorPlaced = placeCursorAtEndOfElement(targetElementId);
        }

        // 2. If no targetElementId or it failed, try saved scroll position
        if (!cursorPlaced) {
          const savedElementId = getSavedScrollElementId(book);
          if (savedElementId) {
            console.log(
              `Trying to place cursor at saved scroll position: ${savedElementId}`
            );
            cursorPlaced = placeCursorAtEndOfElement(savedElementId);
          }
        }

        // 3. Smart fallback based on content length
        if (!cursorPlaced) {
          const contentExceedsViewport = doesContentExceedViewport(editableDiv);
          console.log(`Content exceeds viewport: ${contentExceedsViewport}`);

          if (contentExceedsViewport) {
            // Long content - place cursor at first element (existing behavior)
            const firstElementId = getFirstElementWithId(editableDiv);
            if (firstElementId) {
              console.log(
                `Long content: placing cursor at first element with ID: ${firstElementId}`
              );
              cursorPlaced = placeCursorAtEndOfElement(firstElementId);
            }
          } else {
            // Short content - place cursor at last content element
            const lastContentElementId = getLastContentElement(editableDiv);
            if (lastContentElementId) {
              console.log(
                `Short content: placing cursor at last content element with ID: ${lastContentElementId}`
              );
              cursorPlaced = placeCursorAtEndOfElement(lastContentElementId);
            } else {
              // Fallback to first element if no content elements found
              const firstElementId = getFirstElementWithId(editableDiv);
              if (firstElementId) {
                console.log(
                  `No content elements found: placing cursor at first element with ID: ${firstElementId}`
                );
                cursorPlaced = placeCursorAtEndOfElement(firstElementId);
              }
            }
          }
        }

        // 4. Final fallback - original logic (unchanged)
        if (!cursorPlaced) {
          console.log("Using final fallback cursor placement");
          const selection = window.getSelection();
          if (!selection.rangeCount || selection.isCollapsed) {
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
        }

        editableDiv.focus();
        startObserving(editableDiv);
        addPasteListener(editableDiv);

        console.log("Edit mode enabled");
      } catch (error) {
        console.error("Error during UI update inside setTimeout:", error);
      } finally {
        decrementPendingOperations();
        editModeCheckInProgress = false;
      }
    }, 0);
  } catch (error) {
    console.error("Error waiting for content promise:", error);
    decrementPendingOperations();
    editModeCheckInProgress = false;
  }
}

function disableEditMode() {
  window.isEditing = false; // Reset state immediately
  console.log("🧹 Edit mode state flag reset to false.");

  // ✅ QUERY FOR ELEMENTS AT THE TIME OF EXECUTION
  const editBtn = document.getElementById("editButton");
  const editableDiv = document.getElementById(book);

  if (!editableDiv) {
    console.warn("Editable div not found during disableEditMode, but state was reset.");
    return;
  }

  if (editBtn) {
    editBtn.classList.remove("inverted");
  }

  // Don't modify nav button visibility when exiting edit mode
  // Let the scroll handlers control visibility naturally
  console.log("👁️ Exiting edit mode - nav visibility controlled by scroll handlers");

  enforceEditableState();
  editableDiv.contentEditable = "false";

  // Get the existing toolbar instance and hide it:
  const toolbar = getEditToolbar();
  if (toolbar) {
    toolbar.setEditMode(false);
  }

  stopObserving();

  // Save any pending changes before disabling edit mode
  import('../divEditor.js').then(({ flushAllPendingSaves }) => {
    flushAllPendingSaves();
  });
  
  // Safely clear NodeIdManager if it exists
  if (window.NodeIdManager && typeof NodeIdManager.usedIds !== 'undefined') {
    console.log("Clearing NodeIdManager cache");
    NodeIdManager.usedIds.clear();
  }
  
  console.log("Edit mode disabled");
}

// ✅ CREATE A NEW, EXPORTED INITIALIZER FOR THE LISTENERS
export function initializeEditButtonListeners() {
  const editBtn = document.getElementById("editButton");
  if (editBtn) {
    // This check prevents adding listeners multiple times
    if (editBtn.dataset.listenersAttached) return;

    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Don't do anything if button is in locked state
      if (editBtn.dataset.isLocked === 'true') {
        console.log("🔒 Edit button is locked - no action taken");
        return;
      }
      
      if (window.isEditing) {
        disableEditMode();
      } else {
        enableEditMode();
      }
    });
    
    editBtn.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Don't do anything if button is in locked state
      if (editBtn.dataset.isLocked === 'true') {
        console.log("🔒 Edit button is locked - no action taken");
        return;
      }
      
      if (window.isEditing) {
        disableEditMode();
      } else {
        enableEditMode();
      }
    });
    
    editBtn.dataset.listenersAttached = 'true';
    console.log("✅ Edit button event listeners attached.");
  }
}



export async function updateEditButtonVisibility(bookId) {
  console.log('EDIT BUTTON VISIBILITY CHECK FOR:', bookId);
  const editButton = document.getElementById('editButton');
  if (!editButton) {
    console.log('Edit button not found');
    return;
  }

  editButton.style.display = 'block';
  editButton.classList.remove('hidden');
  
  // After making button visible, check permissions and update UI
  await checkEditPermissionsAndUpdateUI();
}

updateEditButtonVisibility(book);

// Function to replace edit button with lock icon
function replaceEditButtonWithLock() {
  const editBtn = document.getElementById("editButton");
  if (!editBtn) return;

  // Don't replace if already in locked state
  if (editBtn.dataset.isLocked === 'true') {
    console.log("🔒 Button already locked, skipping");
    return;
  }

  // Store original button content and classes for potential restoration
  if (!editBtn.dataset.originalContent) {
    editBtn.dataset.originalContent = editBtn.innerHTML;
    editBtn.dataset.originalClasses = editBtn.className;
  }

  // Replace with lock SVG
  editBtn.innerHTML = `
    <svg fill="currentColor" viewBox="0 0 574.65 574.65" width="100%" height="100%" style="width: 100%; height: 100%;">
      <path d="M424.94,217.315v-79.656C424.94,61.755,363.185,0,287.291,0S149.658,61.739,149.658,137.623v79.742
        c-41.326,28.563-68.46,76.238-68.46,130.287v162.264c0,35.748,28.986,64.734,64.733,64.734h282.787
        c35.748,0,64.734-28.986,64.734-64.734V347.652C493.456,293.574,466.306,245.892,424.94,217.315z M322.136,421.457v49.314
        c0,19.221-15.577,34.811-34.808,34.811c-19.23,0-34.829-15.59-34.829-34.83v-49.283c-14.155-10.627-23.441-27.385-23.441-46.447
        c0-32.174,26.102-58.254,58.252-58.254c32.173,0,58.255,26.084,58.255,58.254C345.563,394.084,336.276,410.832,322.136,421.457z
         M348.241,189.969c-4.344-0.357-8.707-0.665-13.145-0.665h-95.538c-4.456,0-8.837,0.308-13.201,0.665v-52.346
        c0-33.595,27.338-60.922,60.933-60.922c33.612,0,60.95,27.348,60.95,60.959V189.969L348.241,189.969z"/>
    </svg>
  `;

  // Add lock-specific styling
  editBtn.className = editBtn.dataset.originalClasses + ' locked-state';
  editBtn.dataset.isLocked = 'true';

  // Remove any existing event listeners by cloning the element
  const newEditBtn = editBtn.cloneNode(true);
  editBtn.parentNode.replaceChild(newEditBtn, editBtn);

  console.log("✅ Edit button replaced with lock icon");
}

// Function to restore edit button from lock state
function restoreEditButtonFromLock() {
  const editBtn = document.getElementById("editButton");
  if (!editBtn || !editBtn.dataset.isLocked) return;
  
  // Restore original content and classes
  if (editBtn.dataset.originalContent) {
    editBtn.innerHTML = editBtn.dataset.originalContent;
  }
  if (editBtn.dataset.originalClasses) {
    editBtn.className = editBtn.dataset.originalClasses;
  }
  
  // Clean up lock-specific data
  delete editBtn.dataset.isLocked;
  delete editBtn.dataset.originalContent;
  delete editBtn.dataset.originalClasses;
  
  // Re-initialize event listeners
  initializeEditButtonListeners();
  
  console.log("✅ Edit button restored from lock state");
}

// Function to check if user has edit permissions and handle UI accordingly
export async function checkEditPermissionsAndUpdateUI() {
  const currentUser = await getCurrentUser();
  const editBtn = document.getElementById("editButton");

  if (!editBtn) return;

  // Don't modify button during edit mode
  if (window.isEditing) {
    console.log("⚠️ Skipping permission check - edit mode is active");
    return;
  }

  // User is logged in - check permissions
  const canEdit = await canUserEditBook(book);

  if (canEdit) {
    // User has permissions - show edit button
    restoreEditButtonFromLock();
  } else {
    // User doesn't have permissions - show lock
    replaceEditButtonWithLock();
  }
}

// Add this function to your file
// reader-edit.js

// reader-edit.js

async function showCustomAlert(title, message, options = {}) {
  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";

  const user = await getCurrentUser();
  const isLoggedIn = user !== null;
  console.log(`🔍 User login status for alert: ${isLoggedIn ? 'logged in' : 'not logged in'}`);

  // Initial alert content
  let buttonsHtml = "";
  if (options.showReadButton) {
    buttonsHtml += `<button type="button" id="customAlertRead" class="alert-button secondary">Read</button>`;
  }
  if (options.showLoginButton && !isLoggedIn) {
    buttonsHtml += `<button type="button" id="customAlertLogin" class="alert-button primary">Log In</button>`;
  }

  // Initial structure
  alertBox.innerHTML = `
    <div class="user-form">
      <h3>${title}</h3>
      <p>${message}</p>
      <div class="alert-buttons">
        ${buttonsHtml}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(alertBox);

  // --- Event Handlers ---

  // A single, reliable function to close the modal and reset the state.
  function closeAlertAndCancel() {
    if (overlay.parentElement) overlay.remove();
    if (alertBox.parentElement) alertBox.remove();
    document.removeEventListener("keydown", handleEscape);
    handleEditModeCancel(); // Go back to read mode
  }

  // Use event delegation on the alertBox to handle all clicks.
  // This works even after the content changes.
  alertBox.addEventListener("click", (e) => {
    const targetId = e.target.id;

    if (targetId === "customAlertRead" || targetId === "cancelAlert") {
      closeAlertAndCancel();
      if (targetId === "customAlertRead" && options.onRead) {
        options.onRead();
      }
    } else if (targetId === "customAlertLogin") {
      userManager.setPostLoginAction(() => {
        enableEditMode();
      });

      // Get the CORE form HTML from the manager
      const formHTML = userManager.getLoginFormHTML();
      
      // Inject the form HTML. The userManager's global listener will handle
      // the 'loginSubmit' and 'showRegister' buttons automatically.
      alertBox.innerHTML = formHTML;

      // NOW, add the Cancel button, which is specific to this workflow.
      const buttonContainer = alertBox.querySelector(".alert-buttons");
      if (buttonContainer) {
        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.id = "cancelAlert";
        cancelButton.className = "alert-button secondary";
        cancelButton.textContent = "Cancel";
        buttonContainer.appendChild(cancelButton);
      }
    }
  });

  // Prevent default form submission to avoid 422 errors
  alertBox.addEventListener("submit", (e) => {
    e.preventDefault();
    console.log("Form submission prevented - using JavaScript handlers instead");
  });

  // The overlay click should ALWAYS allow cancellation.
  overlay.addEventListener("click", closeAlertAndCancel);

  // The Escape key should ALWAYS allow cancellation.
  function handleEscape(e) {
    if (e.key === "Escape") {
      closeAlertAndCancel();
    }
  }
  document.addEventListener("keydown", handleEscape);
}

export function enforceEditableState() {
  const editableDiv = document.getElementById(book);
  if (!editableDiv) return;
  
  const shouldBeEditable = window.isEditing === true;
  const currentlyEditable = editableDiv.contentEditable === "true";
  
  if (shouldBeEditable !== currentlyEditable) {
    editableDiv.contentEditable = shouldBeEditable ? "true" : "false";
    console.log(`🔧 Fixed contentEditable mismatch: set to ${shouldBeEditable}`);
  }
}

