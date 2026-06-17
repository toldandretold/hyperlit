/**
 * hyperlitContainer listener lifecycle — extracted from index.ts so the orchestrators
 * (postOpen) and the container lifecycle (core/stack) can use them WITHOUT importing
 * ./index. Owns: cleanupContainerListeners (close/SPA-nav teardown + main-editor restore),
 * and the deferred link listeners (data-content-id, private-book access).
 *
 * Imports only the containerState leaf + zero-import app/util leaves.
 */

import { containerState, activeListeners, registerListener } from './containerState';
import { clearActiveBook } from './utilities/activeContext';
import { book } from '../app';

/**
 * Clean up all registered listeners
 * Called when the container closes to prevent listener accumulation.
 * Also stops any active sub-book editor and restores the main editor if it was running.
 */
export async function cleanupContainerListeners({ stackPop = false }: any = {}) {
  for (const { element, event, handler, options } of activeListeners) {
    try {
      element.removeEventListener(event, handler, options);
    } catch (e) {
      // Element may have been removed from DOM, ignore
    }
  }
  activeListeners.length = 0;
  containerState.focusSwitcherAttached = false;

  // Always stop sub-book observer if one is active (even if main editor wasn't active)
  const { getActiveEditSession }: any = await import('../divEditor/editSessionManager');
  const activeSession = getActiveEditSession();
  if (activeSession && activeSession.containerId !== 'main-content') {
    const { stopObserving }: any = await import('../divEditor/index');
    await stopObserving();
  }

  // Skip editor/toolbar restoration when popping a stacked layer
  // (the layer below will restore its own state)
  if (stackPop) return;

  // Restore main editor if it was active before the sub-book editor took over
  if (containerState.mainEditorWasActive) {
    const { startObserving }: any = await import('../divEditor/index');
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      await startObserving(mainContent); // internally calls stopObserving() first
      console.log('✏️ Sub-book editor stopped, main editor restored');
    }
    containerState.mainEditorWasActive = false;
  }

  // Restore (window as any).isEditing to its pre-container value
  (window as any).isEditing = containerState.previousIsEditing;
  containerState.previousIsEditing = false;

  // Clear sub-book context and restore the toolbar to the main book
  clearActiveBook();
  const { getEditToolbar }: any = await import('../editToolbar/index');
  getEditToolbar()?.setBookId(book);

  // Hide toolbar if main book was in read mode (we showed it for hyperlit edit)
  if (!(window as any).isEditing) {
    getEditToolbar()?.setEditMode(false);
  }

  // Defensive: ensure main content and edit button match restored state
  const { enforceEditableState }: any = await import('../components/editButton/index');
  enforceEditableState();

  const mainEditBtn = document.getElementById('editButton');
  if (mainEditBtn) {
    if ((window as any).isEditing) {
      mainEditBtn.classList.add('inverted');
    } else {
      mainEditBtn.classList.remove('inverted');
    }
  }
}

/**
 * Attach listeners to data-content-id links for URL updates
 * Uses registerListener for proper cleanup when container closes
 * @private
 */
export function attachDataContentIdLinkListeners() {
  const links = document.querySelectorAll('[data-content-id]');
  links.forEach((link: any) => {
    const handler = (e: any) => {
      const contentId = link.getAttribute('data-content-id');
      if (contentId) {
        console.log(`🔗 Clicked link with content ID: ${contentId}`);
        // URL update logic handled by navigation system
      }
    };
    registerListener(link, 'click', handler);
  });
}

/**
 * Check private book access and update UI accordingly
 * Uses registerListener for proper cleanup when container closes
 * @private
 */
export async function checkPrivateBookAccess() {
  const privateLinks = document.querySelectorAll('[data-private="true"]');
  if (privateLinks.length === 0) return;

  const { canUserEditBook }: any = await import('../utilities/auth/index');

  for (const link of privateLinks) {
    const bookId = link.getAttribute('data-book-id');
    if (bookId) {
      const hasAccess: any = await canUserEditBook(bookId);
      if (!hasAccess) {
        (link as HTMLElement).style.opacity = '0.6';
        (link as HTMLElement).style.cursor = 'not-allowed';
        const handler = (e: any) => {
          e.preventDefault();
          alert('This book is private. You do not have access.');
        };
        registerListener(link, 'click', handler);
      }
    }
  }
}
