// Edit-mode controller for #editButton (button-only — toggles contentEditable on
// the book div, no ContainerManager). Owns enable/disable/enforce, the click/touch
// listeners (the ButtonRegistry entry), the login/sync custom alert, URL auto-edit,
// and the module-load visibility side-effect. Pure caret helpers live in ./cursor;
// the lock/permission UI in ./lock (re-exported here so importers have one entry).
import { book } from "../../app";
import { verbose } from "../../utilities/logger";
import { trapModalFocus } from "../../utilities/modalFocusTrap";
import { getCurrentUser, canUserEditBook } from "../../utilities/auth/index";
import userManager from "../userButton/userButton";
import {
  placeCursorAtEndOfElement, getSavedScrollElementId, getFirstElementWithId,
  doesContentExceedViewport, getLastContentElement,
} from './cursor';
import { replaceEditButtonWithLock, updateEditButtonVisibility } from './lock';

// Re-export the lock/permission API so external importers keep one entry point.
export { updateEditButtonVisibility, checkEditPermissionsAndUpdateUI } from './lock';

// State flags
(window as any).isEditing = false;

// Re-attach edit-button listeners when lock.ts restores the button (event inversion — avoids lock→index import).
window.addEventListener('editButton:reinit-listeners', () => initializeEditButtonListeners());

let editModeCheckInProgress = false;

export function resetEditModeState() {
  (window as any).isEditing = false;
  editModeCheckInProgress = false;
}

// Handle edit mode cancellation without reload
function handleEditModeCancel() {
  editModeCheckInProgress = false;
  disableEditMode();

  // Clean up ALL edit-related URL parameters
  const currentUrl = new URL(window.location.href);
  currentUrl.searchParams.delete('edit');
  currentUrl.searchParams.delete('target');

  if (currentUrl.pathname.endsWith('/edit')) {
    currentUrl.pathname = currentUrl.pathname.replace(/\/edit$/, '');
  }

  window.history.pushState({}, '', currentUrl.toString());
}

// `targetElementId` is a generic DOM element id to place the caret at (the URL
// `?target=` param, or a saved scroll id) — NOT necessarily a numerical LineId,
// so it stays a plain string (placeCursorAtEndOfElement takes any element id).
export async function enableEditMode(targetElementId: string | null = null, isNewBook = false) {
  const editBtn = document.getElementById("editButton");
  const editableDiv = document.getElementById(book);

  if ((window as any).isEditing || editModeCheckInProgress) {
    return;
  }

  if (!editableDiv) {
    console.error(`no #${book} div`);
    return;
  }

  editModeCheckInProgress = true;

  // This block for permission checking is perfect.
  if ((window as any).pendingBookSyncPromise) {
    try {
      await (window as any).pendingBookSyncPromise;
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
      (window as any).pendingBookSyncPromise = null;
    }
  }

  // Wait for background download if still in progress (chunked lazy loading).
  if ((window as any)._backgroundDownloadInProgress) {
    const { waitForBackgroundDownload } = await import('../../pageLoad/index');
    await waitForBackgroundDownload();
  }

  // THE SINGLE, CORRECT PERMISSION CHECK
  const canEdit = await canUserEditBook(book);

  if (!canEdit) {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      // User not logged in - show login prompt
      userManager.setPostLoginAction(() => {
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
    return;
  }

  // If the code reaches this point, the user HAS permission.

  try {
    // pageLoad is a bootstrap module — dynamic import avoids a static
    // component→bootstrap import cycle (flagged by the acyclic-import gate).
    const { pendingFirstChunkLoadedPromise } = await import("../../pageLoad/index");
    await pendingFirstChunkLoadedPromise;

    setTimeout(async () => {
      try {
        (window as any).isEditing = true;
        verbose.init('Edit mode entered via edit button', '/components/editButton/index.ts');
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
        const { getEditToolbar } = await import('../../editToolbar/index');
        const toolbar = getEditToolbar();
        if (toolbar) {
          toolbar.setEditMode(true);
        }

        // ✅ ONLY call ensureMinimumDocumentStructure for new blank books
        if (isNewBook) {
          import("../../divEditor/index").then((m: any) => {
            m.ensureMinimumDocumentStructure();
          });
        }

        // Cursor placement
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
          const selection = window.getSelection()!;
          if (!selection.rangeCount || selection.isCollapsed) {
            const range = document.createRange();
            const walker = document.createTreeWalker(
              editableDiv,
              NodeFilter.SHOW_TEXT,
              null
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
        const { startObserving } = await import('../../divEditor/index');
        const { addPasteListener } = await import('../../paste/index');

        startObserving(editableDiv, book);
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

export interface DisableEditModeOptions {
  /** On logout the local IDB is wiped + content is already on the server, so skip
   *  the flush + edit-exit integrity sweep (see the block below). */
  skipPersistence?: boolean;
}

export function disableEditMode({ skipPersistence = false }: DisableEditModeOptions = {}) {
  (window as any).isEditing = false; // Reset state immediately

  const editBtn = document.getElementById("editButton");
  const editableDiv = document.getElementById(book);

  if (!editableDiv) {
    console.warn("Editable div not found during disableEditMode, but state was reset.");
    return;
  }

  if (editBtn) {
    editBtn.classList.remove("inverted");
  }

  enforceEditableState();
  editableDiv.contentEditable = "false";

  // ✅ Dynamically import edit modules (they should already be loaded if we were editing)
  Promise.all([
    import('../../editToolbar/index'),
    import('../../divEditor/index')
  ]).then(async ([editToolbar, divEditor]: any[]) => {
    const { getEditToolbar } = editToolbar;
    const { stopObserving, flushAllPendingSaves, flushInputDebounce } = divEditor;

    // Get the existing toolbar instance and hide it:
    const toolbar = getEditToolbar();
    if (toolbar) {
      toolbar.setEditMode(false);
    }

    await stopObserving();

    // On logout (skipPersistence) the local IDB is being wiped and the content
    // is already on the server, so flushing pending saves into a fresh anonymous
    // session and verifying the DOM against an emptied DB is both pointless and
    // the source of false "missingFromIDB" integrity reports. Skip the block.
    if (!skipPersistence) {
    // Flush pending saves BEFORE integrity check so queued nodes
    // are written to IDB before verification
    flushInputDebounce();

    // [diagnostic] snapshot IDB node.content before flush so we can tell
    // whether flushAllPendingSaves itself is mutating IDB content during
    // edit-mode-exit (case a/b) vs the divergence pre-existing (case c).
    let __preFlushSnapshot: any = null;
    try {
      const { getNodesFromIndexedDB } = await import('../../indexedDB/index');
      const preNodes = await getNodesFromIndexedDB(book);
      __preFlushSnapshot = new Map(
        (preNodes || []).map((n: any) => [String(n.startLine), n.content || ''])
      );
      console.log(`[diag][editButton] pre-flush IDB snapshot: ${__preFlushSnapshot.size} nodes for ${book}`);
    } catch (e) {
      console.warn('[diag][editButton] pre-flush snapshot failed', e);
    }

    await flushAllPendingSaves();

    // [diagnostic] diff IDB content after flush
    if (__preFlushSnapshot) {
      try {
        const { getNodesFromIndexedDB } = await import('../../indexedDB/index');
        const postNodes = await getNodesFromIndexedDB(book);
        const changed = [];
        for (const n of postNodes || []) {
          const key = String(n.startLine);
          const before = __preFlushSnapshot.get(key);
          if (before !== undefined && before !== (n.content || '')) {
            changed.push({
              startLine: key,
              beforeLen: before.length,
              afterLen: (n.content || '').length,
              beforeSample: before.slice(0, 200),
              afterSample: (n.content || '').slice(0, 200),
            });
          }
        }
        if (changed.length > 0) {
          console.log(`[diag][editButton] flushAllPendingSaves mutated ${changed.length} IDB nodes`, changed);
        } else {
          console.log('[diag][editButton] flushAllPendingSaves: no IDB content changes');
        }
      } catch (e) {
        console.warn('[diag][editButton] post-flush snapshot failed', e);
      }
    }

    // Verify all saved nodes made it to IDB before leaving edit mode
    try {
      const { verifyNodesIntegrity, findOrphanedNodes, healVerbatimDuplicates } = await import('../../integrity/verifier');
      const container = document.getElementById(book);
      if (container) {
        // Auto-heal verbatim DOM duplicates BEFORE counting nodes so the
        // verifier sees the cleaned DOM (same data-node-id + identical
        // innerHTML is data-safe to drop).
        const healedIds = healVerbatimDuplicates(book);

        const nodeEls = container.querySelectorAll('[id]');
        const nodeIds: any[] = [];
        nodeEls.forEach((el: any) => {
          if (/^\d+(\.\d+)*$/.test(el.id)) nodeIds.push(el.id);
        });
        if (nodeIds.length > 0) {
          const result = await verifyNodesIntegrity(book, nodeIds);
          const orphans = findOrphanedNodes(book);
          if (result.mismatches.length > 0 || result.missingFromIDB.length > 0 || result.duplicateIds.length > 0 || orphans.length > 0) {
            const { reportIntegrityFailure } = await import('../../integrity/reporter');
            reportIntegrityFailure({
              bookId: book,
              mismatches: result.mismatches,
              missingFromIDB: result.missingFromIDB,
              duplicateIds: result.duplicateIds,
              orphanedNodes: orphans,
              trigger: 'edit-mode-exit',
              selfHealed: healedIds.length > 0,
              selfHealedNodeIds: healedIds,
            } as any);
          }
        }
      }
    } catch (e) {
      console.warn('[integrity] Edit-exit verification failed:', e);
    }
    } // end if (!skipPersistence)

    // Check if renumbering is needed (only when decimals are deeply nested)
    const MAX_DECIMAL_DEPTH = 3;
    const needsRenumbering = Array.from(
      document.querySelectorAll('[data-node-id]')
    ).some((el: any) => {
      if (!el.id) return false;
      const decimalPart = el.id.split('.')[1];
      return decimalPart && decimalPart.length >= MAX_DECIMAL_DEPTH;
    });

    if (needsRenumbering) {
      console.log('🔄 IDs need cleanup - triggering renumbering on edit exit');
      import('../../utilities/IDfunctions').then(({ triggerRenumberingWithModal }) => {
        triggerRenumberingWithModal(0);
      });
    }
  }).catch(err => {
    console.warn('Edit modules not loaded:', err);
  });

  // Safely clear NodeIdManager if it exists
  if ((window as any).NodeIdManager && typeof (window as any).NodeIdManager.usedIds !== 'undefined') {
    (window as any).NodeIdManager.usedIds.clear();
  }
}

// Store handler references for proper cleanup (like logoNav pattern)
let editClickHandler: any = null;
let editTouchHandler: any = null;

export function initializeEditButtonListeners() {
  const editBtn = document.getElementById("editButton") as any;
  if (editBtn) {
    // This check prevents adding listeners multiple times
    if (editBtn.dataset.listenersAttached) return;

    // Store handler references
    editClickHandler = (e: any) => {
      e.preventDefault();
      e.stopPropagation();

      // Don't do anything if button is in locked state
      if (editBtn.dataset.isLocked === 'true') {
        return;
      }

      if ((window as any).isEditing) {
        disableEditMode();
      } else {
        enableEditMode();
      }
    };

    editTouchHandler = (e: any) => {
      e.preventDefault();
      e.stopPropagation();

      // Don't do anything if button is in locked state
      if (editBtn.dataset.isLocked === 'true') {
        return;
      }

      if ((window as any).isEditing) {
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
  const editBtn = document.getElementById("editButton") as any;
  if (editBtn) {
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

async function showCustomAlert(title: any, message: any, options: any = {}) {
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

  // Keyboard: trap Tab in the alert (overlay is a sibling, so the alert box is
  // the trap root); Escape cancels back to read mode; focus restored on close.
  const releaseTrap = trapModalFocus(alertBox, { onEscape: () => closeAlertAndCancel() });

  // --- Event Handlers ---

  // A single, reliable function to close the modal and reset the state.
  function closeAlertAndCancel() {
    releaseTrap();
    if (overlay.parentElement) overlay.remove();
    if (alertBox.parentElement) alertBox.remove();
    handleEditModeCancel(); // Go back to read mode
  }

  // Use event delegation on the alertBox to handle all clicks.
  alertBox.addEventListener("click", (e: any) => {
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

      // Show login form inside the .custom-alert. The userManager's global
      // listener will handle 'loginSubmit' and 'showRegister' buttons automatically.
      userManager.showLoginForm();

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
  alertBox.addEventListener("submit", (e: any) => {
    e.preventDefault();
  });

  // The overlay click should ALWAYS allow cancellation.
  overlay.addEventListener("click", closeAlertAndCancel);
  // (Escape is handled by the focus trap above.)
}

export function enforceEditableState() {
  const editableDiv = document.getElementById(book) as any;
  if (!editableDiv) return;

  const shouldBeEditable = (window as any).isEditing === true;
  const currentlyEditable = editableDiv.contentEditable === "true";

  if (shouldBeEditable !== currentlyEditable) {
    editableDiv.contentEditable = shouldBeEditable ? "true" : "false";
  }
}

// Module-load side-effect: reveal the edit button + run the permission check
// (runs at boot via viewManager's static import — unchanged from the original).
updateEditButtonVisibility(book);
