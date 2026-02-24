// ✅ Lazy-loaded edit modules (only imported when entering edit mode)
// import { startObserving, stopObserving } from "../divEditor/index.js";
// import { addPasteListener } from '../paste';
// import { initEditToolbar, getEditToolbar } from '../editToolbar';

import { book } from "../app.js";
import { log, verbose } from "../utilities/logger.js";
import { incrementPendingOperations, decrementPendingOperations } from '../utilities/operationState.js';
import { getCurrentUser, canUserEditBook } from "../utilities/auth.js";
import { getLibraryObjectFromIndexedDB } from '../indexedDB/index.js';
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
function placeCursorAtEndOfElement(elementId) {
  const targetElement = document.getElementById(elementId);

  if (!targetElement) {
    console.warn(`Element with id="${elementId}" not found`);
    return false;
  }

  try {
    // Focus the element first
    targetElement.focus();

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

    return true;
  } catch (error) {
    console.error(`Error placing cursor in element ${elementId}:`, error);
    return false;
  }
}
// Add this helper function to find the first element with an ID
function getFirstElementWithId(container) {
  const elementsWithId = container.querySelectorAll("[id]");
  if (elementsWithId.length > 0) {
    // Filter out sentinel divs that lazy loader creates
    const contentElements = Array.from(elementsWithId).filter(el => {
      const id = el.id;
      return !id.endsWith('-top-sentinel') && !id.endsWith('-bottom-sentinel');
    });

    if (contentElements.length > 0) {
      return contentElements[0].id;
    }
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

  // Filter out elements that are empty, structural, or sentinel divs
  const contentElements = Array.from(elementsWithId).filter(el => {
    const id = el.id;
    const text = el.textContent?.trim();
    // Exclude sentinels and empty elements
    return text &&
           text.length > 0 &&
           !id.endsWith('-top-sentinel') &&
           !id.endsWith('-bottom-sentinel');
  });

  if (contentElements.length === 0) return null;

  // Return the last element with content
  return contentElements[contentElements.length - 1].id;
}

// PASTE THIS ENTIRE FUNCTION INTO resources/js/editButton.js

export async function enableEditMode(targetElementId = null, isNewBook = false) {
  const editBtn = document.getElementById("editButton");
  const editableDiv = document.getElementById(book);

  if (window.isEditing || editModeCheckInProgress) {
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
    }

    editModeCheckInProgress = false;
    return; // IMPORTANT: Stop the function here.
  }

  // =================================================================
  // If the code reaches this point, the user HAS permission.
  // The rest of the function will now execute correctly.
  // =================================================================

  try {
    await pendingFirstChunkLoadedPromise;

    setTimeout(async () => {
      try {
        window.isEditing = true;
        log.init('Edit mode entered via edit button', '/components/editButton.js');
        if (editBtn) editBtn.classList.add("inverted");

        // Ensure perimeter buttons are visible in edit mode
        const bottomRightButtons = document.getElementById("bottom-right-buttons");
        if (bottomRightButtons) {
          bottomRightButtons.classList.remove("perimeter-hidden");
        }
        const bottomLeftButtons = document.getElementById("bottom-left-buttons");
        if (bottomLeftButtons) {
          bottomLeftButtons.classList.remove("perimeter-hidden");
        }

        enforceEditableState();

        editableDiv.contentEditable = "true";

        // ✅ Dynamically import edit toolbar
        const { getEditToolbar } = await import('../editToolbar/index.js');
        const toolbar = getEditToolbar();
        if (toolbar) {
          toolbar.setEditMode(true);
        }

        // ✅ ONLY call ensureMinimumDocumentStructure for new blank books
        if (isNewBook) {
          import("../divEditor/index.js").then(({ ensureMinimumDocumentStructure }) => {
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
            cursorPlaced = placeCursorAtEndOfElement(savedElementId);
          }
        }

        // 3. Smart fallback based on content length
        if (!cursorPlaced) {
          const contentExceedsViewport = doesContentExceedViewport(editableDiv);

          if (contentExceedsViewport) {
            // Long content - place cursor at first element (existing behavior)
            const firstElementId = getFirstElementWithId(editableDiv);
            if (firstElementId) {
              cursorPlaced = placeCursorAtEndOfElement(firstElementId);
            }
          } else {
            // Short content - place cursor at last content element
            const lastContentElementId = getLastContentElement(editableDiv);
            if (lastContentElementId) {
              cursorPlaced = placeCursorAtEndOfElement(lastContentElementId);
            } else {
              // Fallback to first element if no content elements found
              const firstElementId = getFirstElementWithId(editableDiv);
              if (firstElementId) {
                cursorPlaced = placeCursorAtEndOfElement(firstElementId);
              }
            }
          }
        }

        // 4. Final fallback - original logic (unchanged)
        if (!cursorPlaced) {
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

        // ✅ Dynamically import divEditor and paste modules
        const { startObserving } = await import('../divEditor/index.js');
        const { addPasteListener } = await import('../paste/index.js');

        startObserving(editableDiv);
        addPasteListener(editableDiv);
      } catch (error) {
        console.error("Error during UI update inside setTimeout:", error);
      } finally {
        editModeCheckInProgress = false;
      }
    }, 0);
  } catch (error) {
    console.error("Error waiting for content promise:", error);
    editModeCheckInProgress = false;
  }
}

export function disableEditMode() {
  window.isEditing = false; // Reset state immediately

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

  enforceEditableState();
  editableDiv.contentEditable = "false";

  // ✅ Dynamically import edit modules (they should already be loaded if we were editing)
  Promise.all([
    import('../editToolbar/index.js'),
    import('../divEditor/index.js')
  ]).then(async ([editToolbar, divEditor]) => {
    const { getEditToolbar } = editToolbar;
    const { stopObserving, flushAllPendingSaves } = divEditor;

    // Get the existing toolbar instance and hide it:
    const toolbar = getEditToolbar();
    if (toolbar) {
      toolbar.setEditMode(false);
    }

    await stopObserving();

    // Check if renumbering is needed (any ID is not a clean 100-multiple)
    const needsRenumbering = Array.from(
      document.querySelectorAll('[data-node-id]')
    ).some(el => {
      if (!el.id) return false;
      // Fast check for decimals first
      if (el.id.includes('.')) return true;
      // Then check for non-100-multiples
      const id = parseInt(el.id, 10);
      return !isNaN(id) && id % 100 !== 0;
    });

    if (needsRenumbering) {
      console.log('🔄 IDs need cleanup - triggering renumbering on edit exit');
      // Renumbering will flush pending saves internally
      import('../utilities/IDfunctions.js').then(({ triggerRenumberingWithModal }) => {
        triggerRenumberingWithModal(0);
      });
    } else {
      // No decimals - just flush pending saves
      await flushAllPendingSaves();
    }
  }).catch(err => {
    console.warn('Edit modules not loaded:', err);
  });
  
  // Safely clear NodeIdManager if it exists
  if (window.NodeIdManager && typeof NodeIdManager.usedIds !== 'undefined') {
    NodeIdManager.usedIds.clear();
  }
}

// Store handler references for proper cleanup (like logoNav pattern)
let editClickHandler = null;
let editTouchHandler = null;

// ✅ CREATE A NEW, EXPORTED INITIALIZER FOR THE LISTENERS
export function initializeEditButtonListeners() {
  const editBtn = document.getElementById("editButton");
  if (editBtn) {
    // This check prevents adding listeners multiple times
    if (editBtn.dataset.listenersAttached) return;

    // Store handler references
    editClickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Don't do anything if button is in locked state
      if (editBtn.dataset.isLocked === 'true') {
        return;
      }

      if (window.isEditing) {
        disableEditMode();
      } else {
        enableEditMode();
      }
    };

    editTouchHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Don't do anything if button is in locked state
      if (editBtn.dataset.isLocked === 'true') {
        return;
      }

      if (window.isEditing) {
        disableEditMode();
      } else {
        enableEditMode();
      }
    };

    editBtn.addEventListener("click", editClickHandler);
    editBtn.addEventListener("touchend", editTouchHandler);
    editBtn.dataset.listenersAttached = 'true';
  }
}

/**
 * Destroy edit button listeners
 * Properly removes event listeners to prevent accumulation
 */
export function destroyEditButtonListeners() {
  const editBtn = document.getElementById("editButton");
  if (editBtn) {
    // ✅ CRITICAL FIX: Remove actual listeners
    if (editClickHandler) {
      editBtn.removeEventListener("click", editClickHandler);
      editClickHandler = null;
    }
    if (editTouchHandler) {
      editBtn.removeEventListener("touchend", editTouchHandler);
      editTouchHandler = null;
    }
    delete editBtn.dataset.listenersAttached;
  }
}



export async function updateEditButtonVisibility(bookId) {
  log.init(`Edit permissions checked for: ${bookId}`, '/components/editButton.js');
  const editButton = document.getElementById('editButton');
  if (!editButton) {
    verbose.init('Edit button not found in DOM', '/components/editButton.js');
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
}

// Function to check if user has edit permissions and handle UI accordingly
export async function checkEditPermissionsAndUpdateUI() {
  const currentUser = await getCurrentUser();
  const editBtn = document.getElementById("editButton");

  if (!editBtn) return;

  // Don't modify button during edit mode
  if (window.isEditing) {
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
  }
}

