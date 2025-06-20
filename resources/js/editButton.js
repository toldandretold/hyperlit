import {
  startObserving,
  stopObserving,
  initTitleSync
} from "./divEditor.js";
import { book } from "./app.js";
import { incrementPendingOperations, decrementPendingOperations } from './operationState.js';
import { addPasteListener } from './paste.js';
import { getCurrentUser, canUserEditBook } from './auth.js'; // Add this
import { getLibraryObjectFromIndexedDB } from './cache-indexedDB.js'; // Add this



const editBtn     = document.getElementById("editButton");
const editableDiv = document.getElementById(book);

// Detect “edit” from URL
const params   = new URLSearchParams(location.search);
const isEditQ  = params.get("edit") === "1";
const isEditP  = location.pathname.endsWith("/edit");
const shouldAutoEdit = isEditQ || isEditP;

// State flags
window.isEditing = false;

// Add this at the top with your other variables
let editModeCheckInProgress = false;

// Update enableEditMode
async function enableEditMode() {
  console.log("🔔 enableEditMode() called from:", new Error().stack);
  console.log("🔔 enableEditMode() called, shouldAutoEdit=", shouldAutoEdit);
  
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
      "You don't have permission to edit raw.",
      {
        showReadButton: true,
        showLoginButton: true,
        onRead: () => {
          editModeCheckInProgress = false;
          window.location.href = `/${book}`;
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
    editModeCheckInProgress = false; // Reset flag on success
  } catch (error) {
    console.error("Error enabling edit mode:", error);
    editModeCheckInProgress = false; // Reset flag on error
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

export async function updateEditButtonVisibility(bookId) {
  console.log('EDIT BUTTON VISIBILITY CHECK FOR:', bookId);
  const editButton = document.getElementById('editButton');
  if (!editButton) {
    console.log('Edit button not found');
    return;
  }

  const canEdit = await canUserEditBook(bookId);
  
  if (canEdit) {
    editButton.style.display = 'block';
    editButton.classList.remove('hidden');
    console.log('Edit button shown - user can edit');
  } else {
    editButton.style.display = 'none';
    editButton.classList.add('hidden');
    console.log('Edit button hidden - user cannot edit');
  }
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
      
      // Reset flag and redirect to read-only view (same as cancel)
      editModeCheckInProgress = false;
      
      // Remove /edit from URL and redirect
      const currentUrl = window.location.pathname;
      const readOnlyUrl = currentUrl.replace(/\/edit$/, '');
      window.location.href = readOnlyUrl;
    }
  });
  
  // Handle Escape key
  function handleEscape(e) {
    if (e.key === 'Escape' && !alertBox.querySelector('.login-form')) {
      closeAlert();
      document.removeEventListener('keydown', handleEscape);
      
      // Reset flag and redirect to read-only view (same as cancel)
      editModeCheckInProgress = false;
      
      // Remove /edit from URL and redirect
      const currentUrl = window.location.pathname;
      const readOnlyUrl = currentUrl.replace(/\/edit$/, '');
      window.location.href = readOnlyUrl;
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
    
    // Reset flag and redirect to read-only view
    editModeCheckInProgress = false;
    
    // Remove /edit from URL and redirect
    const currentUrl = window.location.pathname;
    const readOnlyUrl = currentUrl.replace(/\/edit$/, '');
    window.location.href = readOnlyUrl;
  });
  
  // Focus the email input
  document.getElementById('alertLoginEmail').focus();
}

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
      // Login successful - close alert and reload page
      const overlay = document.querySelector('.custom-alert-overlay');
      const alertBox = document.querySelector('.custom-alert');
      if (overlay && alertBox) {
        document.body.removeChild(overlay);
        document.body.removeChild(alertBox);
      }
      
      // Reload page to update permissions
      window.location.reload();
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

