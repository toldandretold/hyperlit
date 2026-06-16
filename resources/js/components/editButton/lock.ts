// Lock / permission UI for the edit button: swap the pencil for a lock icon when
// the logged-in user can't edit, restore it when they can, and the permission
// check that drives both. Was the lock/permission half of editButton.js. The one
// back-edge — restoreEditButtonFromLock re-wiring the listeners — uses a dynamic
// import('./index') so there's no static cycle with the controller.
import { book } from "../../app.js";
import { log, verbose } from "../../utilities/logger";
import { getCurrentUser, canUserEditBook } from "../../utilities/auth/index";

// Replace the edit button with a lock icon (logged in, but no permission).
export function replaceEditButtonWithLock() {
  const editBtn = document.getElementById("editButton") as any;
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

// Restore the edit button from the lock state (permission regained).
export async function restoreEditButtonFromLock() {
  const editBtn = document.getElementById("editButton") as any;
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

  // Re-initialize event listeners via an event (index subscribes) — inversion so lock no longer
  // imports index (index already imports lock for the lock/permission UI; this keeps it one-way).
  window.dispatchEvent(new CustomEvent('editButton:reinit-listeners'));
}

export async function updateEditButtonVisibility(bookId: any) {
  log.init(`Edit permissions checked for: ${bookId}`, '/components/editButton/lock.ts');
  const editButton = document.getElementById('editButton');
  if (!editButton) {
    verbose.init('Edit button not found in DOM', '/components/editButton/lock.ts');
    return;
  }

  editButton.style.display = 'block';
  editButton.classList.remove('hidden');

  // After making button visible, check permissions and update UI
  await checkEditPermissionsAndUpdateUI();
}

// Check if user has edit permissions and handle UI accordingly.
export async function checkEditPermissionsAndUpdateUI() {
  const currentUser = await getCurrentUser();
  const editBtn = document.getElementById("editButton");

  if (!editBtn) return;

  // Don't modify button during edit mode
  if ((window as any).isEditing) {
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
