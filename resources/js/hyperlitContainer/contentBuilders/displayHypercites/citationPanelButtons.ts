/**
 * Cited-By panel button UX (display layer): injects the manage / health-check / delete buttons
 * into the "Cited By" panel and runs the health-check colour state machine. The hypercite LOGIC
 * it drives lives in `hypercites/` — the health-check engine (`hypercites/healthCheck`) and the
 * citedIN mutation (`hypercites/deletion` → `removeSpecificCitations`) are dynamically imported
 * here so this display module never statically depends on the logic layer (cycle-proof).
 */

import { book } from '../../../app';
import { canUserEditBook } from "../../../utilities/auth/index";

/**
 * Handle manage citations button click - injects management buttons after auth check
 * @param event - The click event
 */
export async function handleManageCitationsClick(event: any) {
  const svg = event.currentTarget;

  // Show loading state
  svg.style.opacity = '0.5';
  svg.style.pointerEvents = 'none';
  console.log('🔧 Running auth checks and injecting management buttons...');

  const buttonPlaceholders = document.querySelectorAll('.hypercite-management-buttons[data-book-id]');

  // Check permissions for source book (Book A - the one being viewed) AND citing books (Book B)
  // Either creator should be able to delete a broken citation link
  const canEditSource: any = await canUserEditBook(book);

  const citingBookIds = new Set();
  buttonPlaceholders.forEach((placeholder: any) => {
    const bookId = placeholder.dataset.bookId;
    if (bookId) citingBookIds.add(bookId);
  });

  // Batch permission checks for citing books
  const citingPermissionsMap = new Map();
  await Promise.all(Array.from(citingBookIds).map(async (bookId: any) => {
    const canEdit: any = await canUserEditBook(bookId);
    citingPermissionsMap.set(bookId, canEdit);
  }));

  // Inject buttons for all citations (everyone gets health check, source OR citing editors get delete)
  buttonPlaceholders.forEach((placeholder: any) => {
    const bookId = placeholder.dataset.bookId;
    const canEditCiting = citingPermissionsMap.get(bookId);
    const canDelete = canEditSource || canEditCiting;
    const citationUrl = placeholder.dataset.citationUrl;
    const hyperciteId = placeholder.dataset.hyperciteId;
    const sourceHyperciteId = placeholder.dataset.sourceHyperciteId;
    const contentType = placeholder.dataset.contentType || 'node';
    const contentItemId = placeholder.dataset.contentItemId || '';
    const subBookId = placeholder.dataset.subBookId || '';

    // Everyone gets health check button
    let html = `
      <button class="hypercite-health-check-btn"
              data-citing-book="${bookId}"
              data-hypercite-id="${hyperciteId}"
              data-citation-url="${citationUrl}"
              data-content-type="${contentType}"
              data-content-item-id="${contentItemId}"
              data-sub-book-id="${subBookId}"
              title="Check if citation exists"
              type="button">
        <svg width="18" height="18" viewBox="0 0 48 48" fill="currentColor">
          <path d="M12 10C13.1046 10 14 9.10457 14 8C14 6.89543 13.1046 6 12 6C11.2597 6 10.6134 6.4022 10.2676 7H10C8.34315 7 7 8.34315 7 10V19C6.44774 19 5.99531 19.4487 6.04543 19.9987C6.27792 22.5499 7.39568 24.952 9.22186 26.7782C10.561 28.1173 12.2098 29.0755 14 29.583V32C14 33.3064 14.835 34.4177 16.0004 34.8294C16.043 38.7969 19.2725 42 23.25 42C27.2541 42 30.5 38.7541 30.5 34.75V30.75C30.5 28.6789 32.1789 27 34.25 27C36.3211 27 38 28.6789 38 30.75V33.1707C36.8348 33.5825 36 34.6938 36 36C36 37.6569 37.3431 39 39 39C40.6569 39 42 37.6569 42 36C42 34.6938 41.1652 33.5825 40 33.1707V30.75C40 27.5744 37.4256 25 34.25 25C31.0744 25 28.5 27.5744 28.5 30.75V34.75C28.5 37.6495 26.1495 40 23.25 40C20.3769 40 18.0429 37.6921 18.0006 34.8291C19.1655 34.4171 20 33.306 20 32V29.583C21.7902 29.0755 23.4391 28.1173 24.7782 26.7782C26.6044 24.952 27.7221 22.5499 27.9546 19.9987C28.0048 19.4487 27.5523 19 27 19L27 10C27 8.34315 25.6569 7 24 7H23.7324C23.3866 6.4022 22.7403 6 22 6C20.8954 6 20 6.89543 20 8C20 9.10457 20.8954 10 22 10C22.7403 10 23.3866 9.5978 23.7324 9H24C24.5523 9 25 9.44772 25 10V19H25.2095C24.6572 19 24.2166 19.4499 24.1403 19.9969C23.9248 21.5406 23.2127 22.983 22.0979 24.0979C20.7458 25.4499 18.9121 26.2095 17 26.2095C15.088 26.2095 13.2542 25.4499 11.9022 24.0979C10.7873 22.983 10.0753 21.5406 9.8598 19.9969C9.78344 19.4499 9.34286 19 8.79057 19L9 19V10C9 9.44772 9.44772 9 10 9H10.2676C10.6134 9.5978 11.2597 10 12 10Z"/>
        </svg>
      </button>
    `;

    // Source book creator OR citing book creator gets delete button
    if (canDelete) {
      html += `
      <button class="hypercite-delete-btn"
              data-source-book="${book}"
              data-source-hypercite-id="${sourceHyperciteId}"
              data-citation-url="${citationUrl}"
              title="Run health check first"
              type="button"
              disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
      </button>
      `;
    }

    placeholder.innerHTML = html;
  });

  // Attach listeners to newly injected buttons
  const healthCheckButtons = document.querySelectorAll('.hypercite-health-check-btn');
  healthCheckButtons.forEach((btn: any) => {
    btn.addEventListener('click', handleHyperciteHealthCheck);
  });

  const hyperciteDeleteButtons = document.querySelectorAll('.hypercite-delete-btn');
  hyperciteDeleteButtons.forEach((btn: any) => {
    btn.addEventListener('click', handleHyperciteDelete);
  });

  console.log(`🔗 Injected management buttons for ${citingPermissionsMap.size} citing books (canEditSource=${canEditSource}, ${Array.from(citingPermissionsMap.values()).filter(Boolean).length} citing editable)`);
  console.log(`🔗 Attached ${healthCheckButtons.length} health check and ${hyperciteDeleteButtons.length} delete button listeners`);

  // Auto-trigger all health checks immediately and await results
  console.log(`🏥 Auto-triggering ${healthCheckButtons.length} health checks...`);
  const healthCheckPromises = Array.from(healthCheckButtons).map((btn: any) => {
    return handleHyperciteHealthCheck({
      currentTarget: btn,
      preventDefault: () => {},
      stopPropagation: () => {}
    });
  });
  await Promise.allSettled(healthCheckPromises);

  // After health checks, inject bulk delete button if any disconnected citations found
  const enabledDeleteBtns = document.querySelectorAll('.hypercite-delete-btn:not([disabled])');
  if (enabledDeleteBtns.length > 0) {
    const headerDiv = document.querySelector('.hypercites-section > div:first-child');
    const bulkDeleteBtn = document.createElement('button');
    bulkDeleteBtn.className = 'hypercite-bulk-delete-btn';
    bulkDeleteBtn.title = `Delete ${enabledDeleteBtns.length} disconnected citation(s)`;
    bulkDeleteBtn.type = 'button';
    bulkDeleteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="#ef4444" stroke-width="2">
      <path d="M3 6h18M8 6V4h8v2m1 0v14a2 2 0 01-2 2H9a2 2 0 01-2-2V6h10z"/>
    </svg>`;
    bulkDeleteBtn.addEventListener('click', handleDeleteAllDisconnected);
    headerDiv!.appendChild(bulkDeleteBtn);
  }

  // Hide the manage SVG after injection
  svg.style.display = 'none';
}

/**
 * Handle health check button click for hypercites
 * @param event - The click event
 */
export async function handleHyperciteHealthCheck(event: any) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const citingBook = button.getAttribute('data-citing-book');
  const hyperciteId = button.getAttribute('data-hypercite-id');
  const contentType = button.getAttribute('data-content-type') || 'node';
  const contentItemId = button.getAttribute('data-content-item-id') || '';
  const subBookId = button.getAttribute('data-sub-book-id') || '';

  if (!citingBook || !hyperciteId) {
    console.error('Missing data attributes on health check button');
    return;
  }

  console.log(`🏥 Health check: book=${citingBook}, hypercite=${hyperciteId}, type=${contentType}, itemId=${contentItemId}, subBookId=${subBookId}`);

  // Add class immediately to prevent re-clicking during either phase
  button.classList.add('health-check-complete');

  // Find the delete button (sibling)
  const deleteButton = button.parentElement.querySelector('.hypercite-delete-btn');

  // Find the SVG element
  const svg = button.querySelector('svg');

  const { checkHyperciteExists }: any = await import('../../../hypercites/healthCheck');

  // --- Phase 1: IndexedDB only (fast, tentative) ---
  const phase1: any = await checkHyperciteExists(citingBook, hyperciteId, contentType, contentItemId, subBookId, true);

  if (phase1.exists) {
    // Found in IndexedDB — definitive green, no need for phase 2
    svg.style.fill = '#22c55e';
    button.title = phase1.chunkKey ? `Found in chunk ${phase1.chunkKey}` : 'Citation exists';

    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.title = "Can't delete - citation still exists";
    }
    return;
  }

  // Not found in IndexedDB — show orange (tentative, checking server...)
  svg.style.fill = '#f59e0b';
  button.title = 'Checking server...';

  // --- Phase 2: Full check including PostgreSQL (definitive) ---
  const phase2: any = await checkHyperciteExists(citingBook, hyperciteId, contentType, contentItemId, subBookId, false);

  if (phase2.exists) {
    // Found on server — green
    svg.style.fill = '#22c55e';
    button.title = phase2.chunkKey ? `Found in chunk ${phase2.chunkKey}` : 'Citation exists';

    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.title = "Can't delete - citation still exists";
    }
  } else {
    // Confirmed not found — red, enable delete
    svg.style.fill = '#ef4444';
    button.title = 'Citation not found - may have been deleted';

    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.title = 'Delete this orphaned hypercite';
    }
  }
}


/**
 * Handle bulk deletion of all disconnected (red) citations
 * @param event - The click event
 */
async function handleDeleteAllDisconnected(event: any) {
  event.preventDefault();
  event.stopPropagation();

  const enabledBtns = document.querySelectorAll('.hypercite-delete-btn:not([disabled])');
  if (enabledBtns.length === 0) return;

  if (!confirm(`Delete ${enabledBtns.length} disconnected citation(s)?`)) return;

  const sourceHyperciteIdSet = new Set();
  const brokenCitations: any[] = [];

  enabledBtns.forEach((btn: any) => {
    const idStr = btn.getAttribute('data-source-hypercite-id');
    const url = btn.getAttribute('data-citation-url');
    if (idStr) idStr.split(',').forEach((id: any) => sourceHyperciteIdSet.add(id.trim()));
    if (url) brokenCitations.push({ url });
  });

  const sourceBook = enabledBtns[0]!.getAttribute('data-source-book');

  try {
    const { removeSpecificCitations }: any = await import('../../../hypercites/deletion');
    await removeSpecificCitations(
      sourceBook,
      Array.from(sourceHyperciteIdSet),
      brokenCitations
    );

    const { closeHyperlitContainer }: any = await import('../../core.js');
    await closeHyperlitContainer();
  } catch (error) {
    console.error('Error bulk-deleting citations:', error);
    alert('Failed to delete citations. Please try again.');
  }
}

/**
 * Handle delete button click for hypercites
 * @param event - The click event
 */
export async function handleHyperciteDelete(event: any) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const sourceBook = button.getAttribute('data-source-book');
  const sourceHyperciteIdStr = button.getAttribute('data-source-hypercite-id');
  const citationUrl = button.getAttribute('data-citation-url');

  if (!sourceBook || !sourceHyperciteIdStr || !citationUrl) {
    console.error('Missing data attributes on delete button');
    return;
  }

  // Handle comma-separated IDs (for overlapping hypercites)
  const sourceHyperciteIds = sourceHyperciteIdStr.split(',').map((id: any) => id.trim());

  console.log(`🗑️ Deleting specific citation: ${citationUrl} from hypercite(s): ${sourceHyperciteIds.join(', ')}`);

  // Confirm deletion
  if (!confirm(`Delete this citation link?\n\n${citationUrl}`)) {
    return;
  }

  try {
    // Remove this specific citation from the citedIN array
    const { removeSpecificCitations }: any = await import('../../../hypercites/deletion');
    await removeSpecificCitations(sourceBook, sourceHyperciteIds, [{ url: citationUrl }]);

    // Import closeHyperlitContainer from core
    const { closeHyperlitContainer }: any = await import('../../core.js');

    // Close container and reload to show updated state
    await closeHyperlitContainer();
    console.log('✅ Removed citation successfully');
    return;
  } catch (error) {
    console.error('❌ Error deleting citation:', error);
    alert('Failed to delete citation. Please try again.');
    return;
  }
}
