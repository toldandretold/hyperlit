import {
  startObserving,
  stopObserving,
  initTitleSync
} from "./divEditor.js";
import { book } from "./app.js";
import { incrementPendingOperations, decrementPendingOperations } from './operationState.js';
import { addPasteListener } from './paste.js';
import { getCurrentUser, canUserEditBook } from './auth.js';
import { getLibraryObjectFromIndexedDB } from './cache-indexedDB.js';
import { initEditToolbar, getEditToolbar } from './editToolbar.js';

const editBtn     = document.getElementById("editButton");
const editableDiv = document.getElementById(book);

// Detect "edit" from URL
const params   = new URLSearchParams(location.search);
const isEditQ  = params.get("edit") === "1";
const isEditP  = location.pathname.endsWith("/edit");
const shouldAutoEdit = isEditQ || isEditP;


// State flags
window.isEditing = false;

// Add this at the top with your other variables
let editModeCheckInProgress = false;

// Add this function to handle edit mode cancellation without reload
function handleEditModeCancel() {
  // Reset the edit mode check flag
  editModeCheckInProgress = false;
  
  // If we're currently in edit mode, disable it
  if (window.isEditing) {
    disableEditMode();
  }
  
  // Update URL without reload if we're on an /edit path
  const currentUrl = window.location.pathname;
  if (currentUrl.endsWith('/edit')) {
    const readOnlyUrl = currentUrl.replace(/\/edit$/, '');
    // Use pushState to change URL without reload
    window.history.pushState({}, '', readOnlyUrl);
  }
  
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

// Update your enableEditMode function
async function enableEditMode(targetElementId = null) {
  console.log("🔔 enableEditMode() called from:", new Error().stack);
  console.log("🔔 enableEditMode() called, shouldAutoEdit=", shouldAutoEdit);
  console.log("🔔 targetElementId:", targetElementId);
  
  if (window.isEditing || editModeCheckInProgress) {
    console.log("Edit mode already active or check in progress, returning");
    return;
  }
  
  if (!editableDiv) {
    console.error(`no #${book} div`);
    return;
  }

  // In enableEditMode function, add this check at the beginning
  if (window.editPermissionDenied) {
      showCustomAlert(
          "Access Denied", 
          "You don't have permission to edit this book.",
          {
              showReadButton: true,
              showLoginButton: true,
              onRead: () => {
                  window.location.href = `/${book}`;
              }
          }
      );
      return;
  }

  editModeCheckInProgress = true;

  // 🔒 Check if user has permission to edit this book
  const canEdit = await canUserEditBook(book);
  if (!canEdit) {
    console.log("❌ User does not have permission to edit this book");
    
    showCustomAlert(
      "Access Denied", 
      "You don't have permission to edit this book.",
      {
        showReadButton: true,
        showLoginButton: true,
        onRead: () => {
          // This will be handled by handleEditModeCancel now
        }
      }
    );
    
    // Reset flag when alert is shown
    editModeCheckInProgress = false;
    return;
  }

  // Continue with edit mode...
  incrementPendingOperations();
  
  try {
    window.isEditing = true;
    if (editBtn) editBtn.classList.add("inverted");
    editableDiv.contentEditable = "true";

    // Get the existing toolbar instance and show it:
    const toolbar = getEditToolbar();
    if (toolbar) {
      toolbar.setEditMode(true);
    } else {
      console.warn("Toolbar not found - make sure it's initialized");
    }

    const { ensureMinimumDocumentStructure } = await import('./divEditor.js');
    ensureMinimumDocumentStructure();
    
    // Smart cursor placement logic
    let cursorPlaced = false;
    
    // 1. Try to use provided targetElementId
    if (targetElementId) {
      cursorPlaced = placeCursorAtEndOfElement(targetElementId);
    }
    
    // 2. If no targetElementId or it failed, try saved scroll position
    if (!cursorPlaced) {
      const savedElementId = getSavedScrollElementId(book);
      if (savedElementId) {
        console.log(`Trying to place cursor at saved scroll position: ${savedElementId}`);
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
          console.log(`Long content: placing cursor at first element with ID: ${firstElementId}`);
          cursorPlaced = placeCursorAtEndOfElement(firstElementId);
        }
      } else {
        // Short content - place cursor at last content element
        const lastContentElementId = getLastContentElement(editableDiv);
        if (lastContentElementId) {
          console.log(`Short content: placing cursor at last content element with ID: ${lastContentElementId}`);
          cursorPlaced = placeCursorAtEndOfElement(lastContentElementId);
        } else {
          // Fallback to first element if no content elements found
          const firstElementId = getFirstElementWithId(editableDiv);
          if (firstElementId) {
            console.log(`No content elements found: placing cursor at first element with ID: ${firstElementId}`);
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
    initTitleSync(book);
    
    console.log("Edit mode enabled");
    editModeCheckInProgress = false; // Reset flag on success
  } catch (error) {
    console.error("Error enabling edit mode:", error);
    // Make sure to reset editing state on error
    window.isEditing = false;
    if (editBtn) editBtn.classList.remove("inverted");
    editableDiv.contentEditable = "false";
  } finally {
    editModeCheckInProgress = false; // Always reset this flag
    decrementPendingOperations();
  }
}

function disableEditMode() {
  if (!window.isEditing) return;
  window.isEditing = false;
  editBtn.classList.remove("inverted");
  editableDiv.contentEditable = "false";



  // Get the existing toolbar instance and hide it:
  const toolbar = getEditToolbar();
  if (toolbar) {
    toolbar.setEditMode(false);
  }

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
  editBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    console.log("Edit button clicked, current state:", {
      isEditing: window.isEditing,
      checkInProgress: editModeCheckInProgress
    });
    
    // Don't allow clicks while check is in progress
    if (editModeCheckInProgress) {
      console.log("Edit mode check in progress, ignoring click");
      return;
    }
    
    if (window.isEditing) {
      disableEditMode();
    } else {
      enableEditMode();
    }
  });
  console.log("Edit button event listener attached");
}


if (shouldAutoEdit) {
  console.log("Auto-edit detected, enabling edit mode");
  
  // Check for target element ID in URL params
  const targetElementId = params.get("target");
  console.log("Target element ID from URL:", targetElementId);
  
  // Add a small delay to ensure DOM is fully loaded for new books
  if (targetElementId) {
    setTimeout(() => {
      enableEditMode(targetElementId);
    }, 200); // Slightly longer delay for new books
  } else {
    enableEditMode();
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
}

updateEditButtonVisibility(book);

// Add this function to your file
async function showCustomAlert(title, message, options = {}) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'custom-alert-overlay';
  
  // Create alert box
  const alertBox = document.createElement('div');
  alertBox.className = 'custom-alert';
  
  // Check if user is logged in
  const user = await getCurrentUser();
  const isLoggedIn = user !== null;
  
  let buttonsHtml = '';
  if (options.showReadButton) {
    buttonsHtml += `<button type="button" id="customAlertRead" class="alert-button secondary">Read</button>`;
  }
  if (options.showLoginButton && !isLoggedIn) {
    buttonsHtml += `<button type="button" id="customAlertLogin" class="alert-button primary">Log In</button>`;
  }
  
  alertBox.innerHTML = `
    <h3>${title}</h3>
    <p>${message}</p>
    <div class="alert-buttons">
      ${buttonsHtml}
    </div>
  `;
  
  // Add to page
  document.body.appendChild(overlay);
  document.body.appendChild(alertBox);
  
  // Handle button clicks
  const readButton = document.getElementById('customAlertRead');
  const loginButton = document.getElementById('customAlertLogin');

  function closeAlert() {
    document.body.removeChild(overlay);
    document.body.removeChild(alertBox);
  }

  if (readButton) {
    readButton.addEventListener('click', () => {
      closeAlert();
      handleEditModeCancel();
      if (options.onRead) options.onRead();
    });
  }

  if (loginButton) {
    loginButton.addEventListener('click', () => {
      // Don't close the alert, show login form instead
      showLoginFormInAlert(alertBox);
    });
  }

  // Close on overlay click (but not if login form is showing)
  overlay.addEventListener('click', (e) => {
    if (!alertBox.querySelector('.login-form')) {
      closeAlert();
      handleEditModeCancel();
    }
  });

  // Handle Escape key
  function handleEscape(e) {
    if (e.key === 'Escape' && !alertBox.querySelector('.login-form')) {
      closeAlert();
      document.removeEventListener('keydown', handleEscape);
      handleEditModeCancel();
    }
  }
  document.addEventListener('keydown', handleEscape);
}

// Function to show login form inside the alert
function showLoginFormInAlert(alertBox) {
  const loginHTML = `
    <div class="login-form">
      <h3 style="color: #EF8D34; margin-bottom: 15px;">Login</h3>
      <form id="alert-login-form">
        <input type="email" id="alertLoginEmail" placeholder="Email" required 
               style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
        <input type="password" id="alertLoginPassword" placeholder="Password" required 
               style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
        <div class="alert-buttons">
          <button type="submit" id="alertLoginSubmit" class="alert-button primary">
            Login
          </button>
          <button type="button" id="alertLoginCancel" class="alert-button secondary">
            Cancel
          </button>
        </div>
      </form>
    </div>
  `;
  
  alertBox.innerHTML = loginHTML;
  
  // Handle form submission
  const form = document.getElementById('alert-login-form');
  const cancelButton = document.getElementById('alertLoginCancel');
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleAlertLogin();
  });
  
  cancelButton.addEventListener('click', () => {
    // Close the entire alert
    const overlay = document.querySelector('.custom-alert-overlay');
    const alertBox = document.querySelector('.custom-alert');
    if (overlay && alertBox) {
      document.body.removeChild(overlay);
      document.body.removeChild(alertBox);
    }
    
    handleEditModeCancel();
  });
  
  // Focus the email input
  document.getElementById('alertLoginEmail').focus();
}

// Handle login from the alert
// Handle login from the alert
async function handleAlertLogin() {
  const email = document.getElementById('alertLoginEmail').value;
  const password = document.getElementById('alertLoginPassword').value;
  
  try {
    // Get CSRF token (same as your userContainer.js)
    await fetch('/sanctum/csrf-cookie', {
      credentials: 'include'
    });
    
    const csrfToken = getCsrfTokenFromCookie();
    
    const response = await fetch('/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken
      },
      credentials: 'include',
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    
    if (response.ok && data.success) {
      // Login successful - close alert
      const overlay = document.querySelector('.custom-alert-overlay');
      const alertBox = document.querySelector('.custom-alert');
      if (overlay && alertBox) {
        document.body.removeChild(overlay);
        document.body.removeChild(alertBox);
      }
      
      // Reset the edit mode check flag
      editModeCheckInProgress = false;
      
      // Try to enable edit mode automatically
      try {
        await enableEditMode();
      } catch (error) {
        console.error('Error auto-enabling edit mode after login:', error);
        // If auto-enable fails, just reload the page as fallback
        window.location.reload();
      }
    } else {
      showLoginError(data.errors || data.message || 'Login failed');
    }
    
  } catch (error) {
    console.error('Login error:', error);
    showLoginError('Network error occurred');
  }
}

// Show login error in the alert
function showLoginError(errors) {
  const form = document.getElementById('alert-login-form');
  if (!form) return;
  
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = `
    color: #EE4A95; 
    font-size: 12px; 
    margin-top: 10px; 
    padding: 8px; 
    background: rgba(238, 74, 149, 0.1); 
    border-radius: 4px;
  `;
  
  if (typeof errors === 'object' && errors !== null) {
    const errorMessages = [];
    for (const [field, messages] of Object.entries(errors)) {
      if (Array.isArray(messages)) {
        errorMessages.push(...messages);
      } else {
        errorMessages.push(messages);
      }
    }
    errorDiv.innerHTML = errorMessages.join('<br>');
  } else {
    errorDiv.textContent = errors || 'An error occurred';
  }
  
  const existingError = form.querySelector('.error-message');
  if (existingError) existingError.remove();
  
  errorDiv.className = 'error-message';
  form.appendChild(errorDiv);
}

// Helper function to get CSRF token (same as your userContainer.js)
function getCsrfTokenFromCookie() {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; XSRF-TOKEN=`);
  if (parts.length === 2) {
    return decodeURIComponent(parts.pop().split(';').shift());
  }
  return null;
}