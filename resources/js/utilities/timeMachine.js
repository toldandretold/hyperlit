import { book } from '../app.js';
import { openDatabase } from '../indexedDB/index.js';
import {
  clearBookDataFromIndexedDB,
  loadNodeChunksToIndexedDB,
  loadLibraryToIndexedDB,
} from '../postgreSQL.js';

/**
 * Virtual book ID for time machine — keeps historical data
 * isolated from the real book in IndexedDB and the lazy loader.
 */
const virtualBookId = book; // Already "{realBook}/timemachine" from blade
const realBook = window.realBook;

export async function initializeTimeMachine() {
  const timestamp = window.timeMachineTimestamp;
  if (!timestamp || !realBook) {
    window.location.href = `/${realBook || book}`;
    return;
  }

  // Hide edit-related UI
  const hideSelectors = [
    '#edit-button', '#editToolbar', '.edit-toolbar',
    '#hyperlight-button-container', '.hyperlight-buttons'
  ];
  hideSelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.style.display = 'none';
  });

  // Render banner
  renderBanner(timestamp);

  // Fetch time machine data from the new endpoint
  try {
    const resp = await fetch(
      `/api/books/${encodeURIComponent(realBook)}/timemachine-data?at=${encodeURIComponent(timestamp)}`,
      { credentials: 'include' }
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[TimeMachine] fetch failed:', resp.status, errBody);
      showError('Failed to load this version. The snapshot may no longer be available.');
      return;
    }

    const data = await resp.json();

    if (!data.nodes || data.nodes.length === 0) {
      showError('No content found for this version.');
      return;
    }

    // Store in IndexedDB using the normal pipeline functions
    const db = await openDatabase();
    await clearBookDataFromIndexedDB(db, virtualBookId);
    await loadNodeChunksToIndexedDB(db, data.nodes);
    await loadLibraryToIndexedDB(db, data.library);

    // Force read-only after rendering
    // (normal universalPageInitializer → loadHyperText flow handles rendering)
    const main = document.querySelector('main');
    if (main) {
      main.setAttribute('contenteditable', 'false');
    }

  } catch (err) {
    console.error('[TimeMachine] error:', err);
    showError('Could not load version data. Please try again.');
  }
}

/**
 * Clean up time machine data from IndexedDB before navigating away.
 */
async function cleanupTimeMachineData() {
  try {
    const db = await openDatabase();
    await clearBookDataFromIndexedDB(db, virtualBookId);
    console.log('[TimeMachine] cleaned up IndexedDB data');
  } catch (err) {
    console.error('[TimeMachine] cleanup error:', err);
  }
}

function renderBanner(timestamp) {
  const banner = document.createElement('div');
  banner.id = 'timemachine-banner';

  const dateStr = new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const label = document.createElement('span');
  label.textContent = `Viewing version from ${dateStr}`;
  label.style.marginRight = '15px';

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'timemachine-restore-btn';
  restoreBtn.textContent = 'Restore this version';
  restoreBtn.addEventListener('click', () => handleRestore(timestamp));

  const backLink = document.createElement('a');
  backLink.className = 'timemachine-back-link';
  backLink.href = '#';
  backLink.textContent = 'Back to current';
  backLink.addEventListener('click', async (e) => {
    e.preventDefault();
    await cleanupTimeMachineData();
    window.location.href = `/${realBook}`;
  });

  banner.appendChild(label);
  banner.appendChild(restoreBtn);
  banner.appendChild(backLink);
  document.body.prepend(banner);
}

async function handleRestore(timestamp) {
  if (!confirm('Restore this version? This will replace the current book content with this historical version.')) {
    return;
  }

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  try {
    const resp = await fetch(`/api/books/${encodeURIComponent(realBook)}/restore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({ timestamp })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(err.message || 'Failed to restore. You may not have permission.');
      return;
    }

    await cleanupTimeMachineData();
    // Clear the real book's cache so the page loads fresh from server
    const db = await openDatabase();
    await clearBookDataFromIndexedDB(db, realBook);
    window.location.href = `/${realBook}`;

  } catch (err) {
    console.error('[TimeMachine] restore failed:', err);
    alert('Failed to restore version. Please try again.');
  }
}

function showError(message) {
  const main = document.querySelector('main');
  if (main) {
    main.innerHTML = `<p style="color: #aaa; text-align: center; margin-top: 60px;">${message}</p>`;
  }
}
