/**
 * Brain Query module — renders a question input inside the hyperlit container,
 * sends the query to the AI Brain API, and renders the response as sub-book content.
 */

import { buildSubBookId } from '../utilities/subBookIdHelper.js';

// Track whether a brain highlight is pending (created but not yet backed by a successful query).
// Set when injectBrainInput() fires; cleared on successful API response + sub-book load.
let pendingBrainHighlightId = null;

// True while the fetch to /api/ai-brain/query is in-flight.
// When in-flight, the highlight must persist — the server is processing and a
// result will appear on next page load even if the user closes now.
let brainRequestInFlight = false;

/**
 * Clean up a pending brain highlight that was never completed.
 * Called from core.js during closeHyperlitContainer().
 * No-op when no brain query is pending, already succeeded, or request is in-flight.
 */
export async function cleanupPendingBrainHighlight() {
    if (!pendingBrainHighlightId || brainRequestInFlight) return;
    const id = pendingBrainHighlightId;
    pendingBrainHighlightId = null;
    try {
        const { deleteHighlightById } = await import('../hyperlights/deletion.js');
        await deleteHighlightById(id);
    } catch (e) {
        console.warn('BrainQuery: cleanup of pending highlight failed:', e);
    }
}

/**
 * Inject the brain query UI into the hyperlit container scroller.
 * Replaces the normal highlight content with a clean "Consult LLM" layout.
 * @param {HTMLElement} targetEl - The .highlight-annotation element (unused, we replace scroller)
 * @param {Object} highlight - The hyperlight record from IndexedDB
 * @param {HTMLElement} scroller - The container scroller element
 */
export async function injectBrainInput(targetEl, highlight, scroller) {
  if (!scroller) {
    console.warn('BrainQuery: No scroller element');
    return;
  }

  const bookId = highlight.book;
  const selectedText = highlight.highlightedText || '';
  const charData = highlight.charData || {};
  const nodeIds = highlight.node_id ? (Array.isArray(highlight.node_id) ? highlight.node_id : JSON.parse(highlight.node_id || '[]')) : [];
  const highlightId = highlight.hyperlight_id;

  // Mark this highlight as pending — will be cleaned up on container close
  // unless the query succeeds (at which point we clear it).
  pendingBrainHighlightId = highlightId;

  // Replace entire scroller content with brain-specific UI
  scroller.innerHTML = `
    <div class="brain-query-section">
      <h1>Consult LLM data pipeline</h1>
      <div class="brain-query-annotation" contenteditable="true" data-placeholder="Ask a question about the selected text..."></div>
      <div class="brain-action-row">
        <button type="button" class="brain-submit-btn">Ask</button>
        <button type="button" class="brain-cancel-btn">Cancel</button>
      </div>
      <div class="brain-status" style="display:none;"></div>
    </div>
  `;

  const section = scroller.querySelector('.brain-query-section');
  const annotation = section.querySelector('.brain-query-annotation');
  const submitBtn = section.querySelector('.brain-submit-btn');
  const cancelBtn = section.querySelector('.brain-cancel-btn');
  const statusEl = section.querySelector('.brain-status');

  // Placeholder behaviour for contenteditable
  const updatePlaceholder = () => {
    if (!annotation.textContent.trim()) {
      annotation.classList.add('empty');
    } else {
      annotation.classList.remove('empty');
    }
  };
  annotation.classList.add('empty');
  annotation.addEventListener('input', updatePlaceholder);
  annotation.addEventListener('focus', updatePlaceholder);
  annotation.addEventListener('blur', updatePlaceholder);

  // Show the edit toolbar for the brain annotation field
  const { getEditToolbar } = await import('../editToolbar/index.js');
  const toolbar = getEditToolbar();
  if (toolbar) {
    toolbar.setEditMode(true);
  }

  // Autofocus (desktop only to avoid iOS keyboard issues)
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isMobile) {
    setTimeout(() => annotation.focus(), 150);
  }

  // Submit handler
  const handleSubmit = async () => {
    const question = annotation.textContent.trim();
    if (!question) return;

    // Disable input
    annotation.contentEditable = 'false';
    submitBtn.disabled = true;
    cancelBtn.style.display = 'none';

    // Show progressive status messages
    statusEl.style.display = 'block';
    statusEl.textContent = 'Analysing your question...';
    const statusTimers = [];
    statusTimers.push(setTimeout(() => {
      statusEl.textContent = 'Searching for relevant source material...';
    }, 2000));
    statusTimers.push(setTimeout(() => {
      statusEl.textContent = 'Generating scholarly analysis...';
    }, 5000));
    statusTimers.push(setTimeout(() => {
      statusEl.textContent = 'Still working — synthesizing sources...';
    }, 12000));

    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    if (!csrfToken) {
      statusTimers.forEach(t => clearTimeout(t));
      statusEl.textContent = 'Error: No CSRF token found';
      annotation.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
      return;
    }

    brainRequestInFlight = true;

    try {
      const response = await fetch('/api/ai-brain/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          selectedText,
          question,
          bookId,
          highlightId,
          nodeIds: Array.isArray(nodeIds) ? nodeIds : Object.keys(charData),
          charData,
        }),
      });

      brainRequestInFlight = false;
      statusTimers.forEach(t => clearTimeout(t));

      const data = await response.json();

      if (!response.ok || !data.success) {
        const msg = data.message || 'AI query failed';
        if (response.status === 402) {
          statusEl.innerHTML = '';
          statusEl.textContent = msg;
          const topUpBtn = document.createElement('a');
          topUpBtn.href = '#';
          topUpBtn.textContent = 'Top Up Balance';
          topUpBtn.style.cssText = 'display:inline-block;margin-top:8px;padding:6px 14px;background:#d63384;color:#fff;border-radius:4px;text-decoration:none;font-size:13px;font-weight:500;';
          topUpBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
              const resp = await fetch('/api/billing/checkout', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'X-XSRF-TOKEN': decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || ''),
                },
                credentials: 'include',
                body: JSON.stringify({ amount: 5, return_url: window.location.href }),
              });
              const d = await resp.json();
              if (d.checkout_url) window.location.href = d.checkout_url;
            } catch (err) {
              console.warn('Top-up checkout failed:', err);
            }
          });
          statusEl.appendChild(document.createElement('br'));
          statusEl.appendChild(topUpBtn);
        } else {
          statusEl.textContent = msg;
        }
        annotation.contentEditable = 'true';
        submitBtn.disabled = false;
        cancelBtn.style.display = '';
        return;
      }

      // Success — turn off edit mode (this is AI-generated content, not user-editable)
      const { getEditToolbar: getToolbar } = await import('../editToolbar/index.js');
      const tb = getToolbar();
      if (tb) {
        tb.setEditMode(false);
      }

      // Clear scroller for sub-book content
      scroller.innerHTML = '';

      // Write records to IndexedDB
      await writeRecordsToIndexedDB(data);

      // Update the hyperlight in IndexedDB with sub_book_id and preview_nodes
      await updateHyperlightInIndexedDB(highlightId, data.subBookId, data.preview_nodes || data.nodes?.slice(0, 5) || []);

      // Build a target element for loadSubBook
      const subBookTarget = document.createElement('div');
      subBookTarget.className = 'highlight-annotation';
      subBookTarget.setAttribute('data-highlight-id', highlightId);
      scroller.appendChild(subBookTarget);

      // Load sub-book content into the container
      const { loadSubBook } = await import('./subBookLoader.js');
      const subBookId = data.subBookId;

      await loadSubBook(subBookId, bookId, highlightId, 'hyperlight', scroller, {
        previewNodes: data.preview_nodes || null,
        targetElement: subBookTarget,
        mode: 'read',
      });

      // Success — highlight now has content, so it must persist.
      pendingBrainHighlightId = null;

    } catch (error) {
      brainRequestInFlight = false;
      statusTimers.forEach(t => clearTimeout(t));
      console.error('BrainQuery: Fetch error:', error);
      statusEl.textContent = 'Network error. Try again.';
      annotation.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
    }
  };

  submitBtn.addEventListener('click', handleSubmit);

  // Cancel handler — just close the container; the close flow handles cleanup
  cancelBtn.addEventListener('click', async () => {
    const { closeHyperlitContainer } = await import('./core.js');
    await closeHyperlitContainer();
  });
}

/**
 * Poll the server for a brain query result when reopening a highlight
 * that was submitted but closed before the response arrived.
 * Shows a "processing" status and loads the sub-book when ready.
 * @param {Object} highlight - The hyperlight record from IndexedDB
 * @param {HTMLElement} scroller - The container scroller element
 */
export async function injectBrainPolling(highlight, scroller) {
    const highlightId = highlight.hyperlight_id;
    const bookId = highlight.book;
    console.log('BrainPolling: starting for', highlightId);

    scroller.innerHTML = `
        <div class="brain-query-section">
            <h1>Brain query in progress</h1>
            <div class="brain-status">Checking for results...</div>
        </div>
    `;
    const statusEl = scroller.querySelector('.brain-status');
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

    let attempts = 0;
    const maxAttempts = 60; // 3s × 60 = 3 min

    const poll = async () => {
        attempts++;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(`/api/ai-brain/status/${highlightId}`, {
                headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': csrfToken },
                signal: controller.signal,
            });
            clearTimeout(timeout);
            const data = await resp.json();

            if (data.status === 'completed') {
                statusEl.textContent = 'Result ready — loading...';
                await updateHyperlightInIndexedDB(highlightId, data.sub_book_id, data.preview_nodes || []);

                scroller.innerHTML = '';
                const subBookTarget = document.createElement('div');
                subBookTarget.className = 'highlight-annotation';
                subBookTarget.setAttribute('data-highlight-id', highlightId);
                scroller.appendChild(subBookTarget);

                const { loadSubBook } = await import('./subBookLoader.js');
                await loadSubBook(data.sub_book_id, bookId, highlightId, 'hyperlight', scroller, {
                    previewNodes: data.preview_nodes || null,
                    targetElement: subBookTarget,
                    mode: 'read',
                });
                return;
            }

            if (data.status === 'not_found') {
                statusEl.textContent = 'Brain query not found. It may have been removed.';
                return;
            }

            statusEl.textContent = 'Brain query still processing...';
        } catch (e) {
            statusEl.textContent = 'Checking server...';
        }

        if (attempts < maxAttempts) {
            setTimeout(poll, 3000);
        } else {
            statusEl.textContent = 'Taking longer than expected. Close and reopen to check again.';
        }
    };

    await poll();
}

/**
 * Write library, nodes, hyperlight, and hypercites from the API response to IndexedDB.
 */
async function writeRecordsToIndexedDB(data) {
  const { nodes, library, hyperlight, hypercites } = data;

  try {
    const { openDatabase } = await import('../indexedDB/index.js');
    const db = await openDatabase();

    // Write library record
    if (library) {
      const libTx = db.transaction(['library'], 'readwrite');
      const libStore = libTx.objectStore('library');
      libStore.put({
        book: library.book,
        title: library.title,
        type: library.type,
        visibility: library.visibility,
        has_nodes: library.has_nodes,
        timestamp: 0,
        raw_json: '[]',
      });
      await new Promise((resolve, reject) => {
        libTx.oncomplete = resolve;
        libTx.onerror = () => reject(libTx.error);
      });
    }

    // Write nodes
    if (nodes && nodes.length > 0) {
      const nodeTx = db.transaction(['nodes'], 'readwrite');
      const nodeStore = nodeTx.objectStore('nodes');
      for (const node of nodes) {
        nodeStore.put({
          book: node.book,
          chunk_id: node.chunk_id,
          startLine: node.startLine,
          node_id: node.node_id,
          content: node.content,
          plainText: node.plainText,
          raw_json: '[]',
        });
      }
      await new Promise((resolve, reject) => {
        nodeTx.oncomplete = resolve;
        nodeTx.onerror = () => reject(nodeTx.error);
      });
    }

    // Write hyperlight
    if (hyperlight) {
      const hlTx = db.transaction(['hyperlights'], 'readwrite');
      const hlStore = hlTx.objectStore('hyperlights');
      hlStore.put({
        book: hyperlight.book,
        hyperlight_id: hyperlight.hyperlight_id,
        sub_book_id: hyperlight.sub_book_id,
        node_id: hyperlight.node_id,
        charData: hyperlight.charData,
        annotation: hyperlight.annotation,
        highlightedText: hyperlight.highlightedText,
        creator: hyperlight.creator,
        time_since: hyperlight.time_since,
        preview_nodes: hyperlight.preview_nodes || null,
        raw_json: '{}',
        hidden: false,
      });
      await new Promise((resolve, reject) => {
        hlTx.oncomplete = resolve;
        hlTx.onerror = () => reject(hlTx.error);
      });
    }

    // Write hypercites
    if (hypercites && hypercites.length > 0) {
      const hcTx = db.transaction(['hypercites'], 'readwrite');
      const hcStore = hcTx.objectStore('hypercites');
      for (const hc of hypercites) {
        hcStore.put({
          book: hc.book,
          hyperciteId: hc.hyperciteId,
          node_id: hc.node_id,
          charData: hc.charData,
          citedIN: hc.citedIN,
          hypercitedText: hc.hypercitedText,
          relationshipStatus: hc.relationshipStatus,
          creator: hc.creator,
          time_since: hc.time_since,
          raw_json: '{}',
        });
      }
      await new Promise((resolve, reject) => {
        hcTx.oncomplete = resolve;
        hcTx.onerror = () => reject(hcTx.error);
      });
    }
  } catch (e) {
    console.warn('BrainQuery: Failed to write to IndexedDB (non-fatal):', e);
  }
}

/**
 * Update the existing hyperlight record in IndexedDB with sub_book_id and preview_nodes.
 */
async function updateHyperlightInIndexedDB(highlightId, subBookId, previewNodes) {
  try {
    const { openDatabase } = await import('../indexedDB/index.js');
    const db = await openDatabase();

    const tx = db.transaction(['hyperlights'], 'readwrite');
    const store = tx.objectStore('hyperlights');
    const idx = store.index('hyperlight_id');

    const existing = await new Promise((resolve) => {
      const req = idx.get(highlightId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (existing) {
      existing.sub_book_id = subBookId;
      existing.preview_nodes = previewNodes;
      store.put(existing);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      console.log('BrainQuery: Updated hyperlight with sub_book_id:', subBookId);
    }
  } catch (e) {
    console.warn('BrainQuery: Failed to update hyperlight in IndexedDB:', e);
  }
}
