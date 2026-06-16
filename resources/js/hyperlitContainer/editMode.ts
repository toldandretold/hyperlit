/**
 * hyperlitContainer edit-mode + focus controls — extracted from index.ts so the
 * orchestrators (postOpen) and the stack can use them WITHOUT importing ./index.
 * Owns: the edit-button toggle ceremony, contenteditable toggling, topmost-focus,
 * the sub-book focus switcher, and applyCurrentEditModeToLayer (called by stack on pop).
 *
 * Imports only leaves/one-way deps (containerState leaf, core, stack) — the back-edges
 * from core/stack into here are dynamic, so no static cycle.
 */

import { containerState, registerListener } from './containerState';
import { getCurrentContainer } from './containerActions';
import { getHyperlitEditMode, toggleHyperlitEditMode, prepareContainerClose } from './core';
import { ProgressOverlayConductor } from '../SPA/navigation/ProgressOverlayConductor.js';

// ============================================================================
// EDIT BUTTON HELPERS
// ============================================================================

/**
 * Build the edit button HTML
 * @param {boolean} isActive - Whether edit mode is currently active
 * @returns {string} HTML string for edit button
 */
export function buildEditButtonHtml(isActive: any) {
  return `
    <button class="hyperlit-edit-btn ${isActive ? 'inverted' : ''}"
            title="${isActive ? 'Exit edit mode' : 'Enter edit mode'}">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
        <path d="M12 20h9" stroke="#CBCCCC"></path>
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="#CBCCCC"></path>
      </svg>
    </button>`;
}

/**
 * Handle edit button click - toggle edit mode in-place without rebuilding content
 * Preserves scroll position and simply toggles contenteditable attributes
 */
export async function handleEditButtonClick() {
  const newState = toggleHyperlitEditMode();
  const container = getCurrentContainer();
  const editBtn = container?.querySelector('.hyperlit-edit-btn');
  const scroller = container?.querySelector('.scroller');

  // Save scroll position BEFORE any DOM changes
  const scrollTop = scroller?.scrollTop || 0;

  // Update button visual state
  if (editBtn) {
    if (newState) {
      editBtn.classList.add('inverted');
      editBtn.title = 'Exit edit mode';
    } else {
      editBtn.classList.remove('inverted');
      editBtn.title = 'Enter edit mode';
    }
  }

  // Attach or detach edit listeners
  if (newState) {
    // Toggle contenteditable BEFORE attaching observers (enable path only).
    // The disable path moves this to AFTER stopObserving() — see below.
    toggleContentEditableInPlace(true);
    const { attachNoteListeners, initializePlaceholders }: any = await import('./noteListener.js');
    attachNoteListeners();
    initializePlaceholders();

    // Set up focus-based observer switching for sub-books
    attachSubBookFocusSwitcher();

    // Attach observer to the first editable sub-book
    const firstEditable = container.querySelector('.sub-book-content[data-user-can-edit="true"]');
    if (firstEditable) {
      const subBookId = firstEditable.getAttribute('data-book-id');
      const { startObserving, isEditorObserving }: any = await import('../divEditor/index');
      if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
      if (!containerState.previousIsEditing) containerState.previousIsEditing = (window as any).isEditing;
      if (!(window as any).isEditing) (window as any).isEditing = true;
      firstEditable.contentEditable = 'true';
      await startObserving(firstEditable, subBookId);
      if (!firstEditable.dataset.pasteAttached) {
        const { addPasteListener }: any = await import('../paste/index.js');
        addPasteListener(firstEditable);
        firstEditable.dataset.pasteAttached = 'true';
      }
      const { getEditToolbar: getToolbar }: any = await import('../editToolbar/index');
      getToolbar()?.setBookId(subBookId);
      getToolbar()?.setEditMode(true);
    }
  } else {
    // Re-entrancy guard: prevent race with concurrent close
    if (containerState.isSavingEditToggle) return;
    containerState.isSavingEditToggle = true;

    try {
      // Same save ceremony as saveAndCloseHyperlitContainer
      ProgressOverlayConductor.showSPATransition(50, 'Saving your changes...', true);
      try {
        // Flush input debounce + SaveQueue + save preview_nodes
        await prepareContainerClose();

        ProgressOverlayConductor.updateProgress(100, 'Save complete' as any);
        await new Promise((resolve: any) => setTimeout(resolve, 150));
      } finally {
        await ProgressOverlayConductor.hide();
      }

      const { detachNoteListeners }: any = await import('./noteListener.js');
      detachNoteListeners();

      // Tear down observer (already flushed by prepareContainerClose)
      const { stopObserving }: any = await import('../divEditor/index');
      await stopObserving();

      // Mirror editButton.js's exit-edit-mode integrity sweep for the
      // sub-book whose edit mode we're exiting. Without this, sub-books
      // could accumulate DOM-vs-IDB mismatches / orphaned nodes /
      // duplicate ids and the user would never see the integrity modal —
      // only the main book's #editButton triggers that path historically.
      try {
        const { runIntegritySweep }: any = await import('../integrity/verifier.js');
        const editableSubBook = container?.querySelector('.sub-book-content[data-user-can-edit="true"]');
        const subBookId = editableSubBook?.getAttribute('data-book-id');
        if (editableSubBook && subBookId) {
          await runIntegritySweep(subBookId, editableSubBook, 'hyperlit-edit-btn-off');
        }
      } catch (e) {
        console.warn('[integrity] sub-book edit-off sweep failed:', e);
      }

      // Toggle contenteditable AFTER the observer is disconnected.
      // The browser's text-node normalization from contenteditable=false generates
      // artifact childList mutations. By disconnecting first, those mutations are
      // never captured, preventing stale IDB writes to the wrong book.
      toggleContentEditableInPlace(false);

      // Hide toolbar if main book was in read mode
      if (!containerState.previousIsEditing) {
        const { getEditToolbar: getToolbar }: any = await import('../editToolbar/index');
        getToolbar()?.setEditMode(false);
      }

      // Restore (window as any).isEditing to pre-container value
      // (containerState.previousIsEditing is NOT cleared here — cleanupContainerListeners()
      // handles the final reset when the container actually closes)
      (window as any).isEditing = containerState.previousIsEditing;
    } finally {
      containerState.isSavingEditToggle = false;
    }
  }

  // Restore scroll position
  if (scroller) {
    scroller.scrollTop = scrollTop;
  }

  // If entering edit mode, focus topmost editable (without scrolling)
  if (newState) {
    focusTopmostEditableElement(true); // preventScroll = true
  }
}

/**
 * Focus the topmost editable element in the hyperlit container
 * Priority: footnote first, then first editable annotation
 * @param {boolean} preventScroll - If true, prevents scrolling when focusing
 */
export function focusTopmostEditableElement(preventScroll: any = false) {
  const container = getCurrentContainer();
  if (!container) return;

  // First try to find an editable sub-book (lazy-loaded content with divEditor)
  const editableSubBook = container.querySelector('.sub-book-content[contenteditable="true"]');
  if (editableSubBook) {
    const firstNode = editableSubBook.querySelector('.chunk p, .chunk [id]');
    if (firstNode) {
      firstNode.focus({ preventScroll: true });
      placeCursorAtEnd(firstNode);
      console.log('✏️ Focused topmost editable sub-book');
      return;
    }
  }

  // Then try to find an editable footnote (always at the top when present)
  const editableFootnote = container.querySelector('.footnote-text[contenteditable="true"]');
  if (editableFootnote) {
    editableFootnote.focus({ preventScroll: true });
    // Place cursor at end of content
    placeCursorAtEnd(editableFootnote);
    console.log('✏️ Focused topmost editable footnote');
    return;
  }

  // Otherwise find the first editable annotation (highlight annotation)
  const editableAnnotation = container.querySelector('.annotation[contenteditable="true"]');
  if (editableAnnotation) {
    editableAnnotation.focus({ preventScroll: true });
    // Place cursor at end of content
    placeCursorAtEnd(editableAnnotation);
    console.log('✏️ Focused topmost editable annotation');
    return;
  }

  console.log('✏️ No editable elements found to focus');
}

/**
 * Toggle contenteditable attribute on all editable elements in-place
 * Uses data-user-can-edit attribute to determine which elements should be toggled
 * @param {boolean} enabled - Whether edit mode is enabled
 */
export function toggleContentEditableInPlace(enabled: any) {
  const container = getCurrentContainer();
  if (!container) return;

  // Toggle footnotes (user must have permission - check data attribute)
  container.querySelectorAll('.footnote-text[data-user-can-edit="true"]').forEach((el: any) => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  // Toggle annotations (user must have permission - check data attribute)
  container.querySelectorAll('.annotation[data-user-can-edit="true"]').forEach((el: any) => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  // Toggle highlight text (user must have permission - check data attribute)
  container.querySelectorAll('.highlight-text[data-user-can-edit="true"]').forEach((el: any) => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  // Toggle sub-book content (lazy-loaded footnotes and highlight annotations)
  container.querySelectorAll('.sub-book-content[data-user-can-edit="true"]').forEach((el: any) => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  console.log(`✏️ Toggled contenteditable=${enabled} on editable elements`);
}

/**
 * Apply the current global isHyperlitEditMode to the restored (now-top) layer.
 * Called by stack.js after popping a stacked layer to sync the DOM with the
 * shared edit toggle — instead of restoring a per-layer saved value.
 */
export async function applyCurrentEditModeToLayer() {
  const isEdit = getHyperlitEditMode();
  const container = getCurrentContainer();
  if (!container) return;

  // Toggle contenteditable on all editable elements
  toggleContentEditableInPlace(isEdit);

  // Update the edit button visual in this container
  const editBtn = container.querySelector('.hyperlit-edit-btn');
  if (editBtn) {
    if (isEdit) {
      editBtn.classList.add('inverted');
      editBtn.title = 'Exit edit mode';
    } else {
      editBtn.classList.remove('inverted');
      editBtn.title = 'Enter edit mode';
    }
  }

  if (isEdit) {
    // Edit ON: set (window as any).isEditing, attach listeners, start observer
    if (!(window as any).isEditing) (window as any).isEditing = true;

    const { attachNoteListeners, initializePlaceholders }: any = await import('./noteListener.js');
    attachNoteListeners();
    initializePlaceholders();
    attachSubBookFocusSwitcher();

    // Attach observer to first editable sub-book
    const firstEditable = container.querySelector('.sub-book-content[data-user-can-edit="true"]');
    if (firstEditable) {
      const subBookId = firstEditable.getAttribute('data-book-id');
      const { startObserving, isEditorObserving }: any = await import('../divEditor/index');
      if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
      firstEditable.contentEditable = 'true';
      await startObserving(firstEditable, subBookId);
      if (!firstEditable.dataset.pasteAttached) {
        const { addPasteListener }: any = await import('../paste/index.js');
        addPasteListener(firstEditable);
        firstEditable.dataset.pasteAttached = 'true';
      }
      const { getEditToolbar: getToolbar }: any = await import('../editToolbar/index');
      getToolbar()?.setBookId(subBookId);
      getToolbar()?.setEditMode(true);
    }
  } else {
    // Edit OFF: restore (window as any).isEditing, hide toolbar if main was in read mode
    (window as any).isEditing = containerState.previousIsEditing;

    if (!containerState.previousIsEditing) {
      const { getEditToolbar: getToolbar }: any = await import('../editToolbar/index');
      getToolbar()?.setEditMode(false);
    }
  }
}

/**
 * Place cursor at the end of a contenteditable element
 * @param {HTMLElement} element - The contenteditable element
 */
export function placeCursorAtEnd(element: any) {
  const range = document.createRange();
  const selection = window.getSelection();
  range.selectNodeContents(element);
  range.collapse(false); // false = collapse to end
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// ============================================================================
// SUB-BOOK FOCUS SWITCHING
// ============================================================================

/**
 * Attach a focusin listener on the container that switches the divEditor
 * MutationObserver when focus enters a different sub-book.
 * Uses registerListener() so it's cleaned up on container close.
 */
export function attachSubBookFocusSwitcher() {
  if (containerState.focusSwitcherAttached) return;
  containerState.focusSwitcherAttached = true;

  const container = getCurrentContainer();
  if (!container) { containerState.focusSwitcherAttached = false; return; }

  const handler = async (e: any) => {
    if (!getHyperlitEditMode()) return;

    const subBookEl = e.target.closest('.sub-book-content[data-user-can-edit="true"]');
    if (!subBookEl) return;

    const subBookId = subBookEl.getAttribute('data-book-id');
    if (!subBookId) return;

    // Skip if already observing this sub-book
    const { getActiveEditSession }: any = await import('../divEditor/editSessionManager');
    const activeSession = getActiveEditSession();
    if (activeSession && activeSession.containerId === subBookId) return;

    // Switch observer to the newly focused sub-book
    const { startObserving, isEditorObserving }: any = await import('../divEditor/index');
    if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
    if (!(window as any).isEditing) (window as any).isEditing = true;

    await startObserving(subBookEl, subBookId); // auto-stops + flushes previous

    // Guard against duplicate paste listeners
    if (!subBookEl.dataset.pasteAttached) {
      const { addPasteListener }: any = await import('../paste/index.js');
      addPasteListener(subBookEl);
      subBookEl.dataset.pasteAttached = 'true';
    }

    const { getEditToolbar: getToolbar }: any = await import('../editToolbar/index');
    getToolbar()?.setBookId(subBookId);

    console.log(`✏️ Focus switched to sub-book: ${subBookId}`);
  };

  registerListener(container, 'focusin', handler);
}
