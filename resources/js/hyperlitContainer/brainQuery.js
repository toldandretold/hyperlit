/**
 * Brain Query module — renders a question input inside the hyperlit container,
 * sends the query to the AI Brain API, and renders the response as sub-book content.
 */

import { buildSubBookId } from '../utilities/subBookIdHelper.js';
import { isLoggedIn } from '../utilities/auth.js';

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

  const highlightId = highlight.hyperlight_id;

  // Mark this highlight as pending cleanup immediately — before any early returns.
  // cleanupPendingBrainHighlight() (called from core.js on container close) will
  // delete it unless a successful query clears the flag later.
  pendingBrainHighlightId = highlightId;

  // Auth gate — unauthenticated users cannot use the AI Archivist
  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    scroller.innerHTML = `
      <div class="brain-query-section">
        <h1>Ask AI Archivist</h1>
        <p class="brain-auth-message">You need to <a class="brain-auth-link brain-auth-login-link">log in</a> or <a class="brain-auth-link brain-auth-register-link">register</a> to use the AI Archivist.</p>
      </div>`;

    scroller.querySelector('.brain-auth-login-link').addEventListener('click', async () => {
      const { saveAndCloseHyperlitContainer } = await import('./core.js');
      await saveAndCloseHyperlitContainer();
      const { initializeUserContainer } = await import('../components/userContainer.js');
      const mgr = initializeUserContainer();
      if (mgr) mgr.showLoginForm();
    });
    scroller.querySelector('.brain-auth-register-link').addEventListener('click', async () => {
      const { saveAndCloseHyperlitContainer } = await import('./core.js');
      await saveAndCloseHyperlitContainer();
      const { initializeUserContainer } = await import('../components/userContainer.js');
      const mgr = initializeUserContainer();
      if (mgr) mgr.showRegisterForm();
    });
    return;
  }

  const bookId = highlight.book;
  const selectedText = highlight.highlightedText || '';
  const charData = highlight.charData || {};
  const nodeIds = highlight.node_id ? (Array.isArray(highlight.node_id) ? highlight.node_id : JSON.parse(highlight.node_id || '[]')) : [];

  // Replace entire scroller content with brain-specific UI
  scroller.innerHTML = `
    <div class="brain-query-section">
      <h1>Ask AI Archivist <span class="brain-info-toggle" tabindex="0" role="button" aria-label="AI Archivist info">?</span></h1>
      <div class="brain-info-detail brain-archivist-info" style="display:none;">
        Your question is first mediated by DeepSeek, which decides whether the prompt, and contextualised text selection, requires further sources. If necessary, DeepSeek extracts key words and text for vector embeddings, which are used to pull related content from the hyperlit library. The results of this archival work are analysed and then hypercited, so that it connects to the source material.
      </div>
      <div class="brain-query-annotation" contenteditable="true" data-placeholder="Ask a question about the selected text..."></div>
      <div class="brain-section-label">
        Limit archival search to:
        <span class="brain-info-toggle" tabindex="0" role="button" aria-label="Scope info">?</span>
        <span class="brain-info-detail" style="display:none;">
          The Archival Assistant may pull sources from across the hyperlit library. Limit the scope of these searches to:<br>
          <strong>Public</strong>: All publicly available hypertext<br>
          <strong>Private</strong>: books you imported into your library, including private ones.<br>
          <strong>All</strong>: Both public and private books.<br>
          <strong>Here</strong>: only this hypertext.
        </span>
      </div>
      <div class="brain-scope-toggle">
        <button type="button" class="brain-scope-btn active" data-scope="public">Public</button>
        <button type="button" class="brain-scope-btn" data-scope="mine">Personal</button>
        <button type="button" class="brain-scope-btn" data-scope="all">All</button>
        <button type="button" class="brain-scope-btn" data-scope="this">Here</button>
      </div>
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
  const scopeBtns = section.querySelectorAll('.brain-scope-btn');

  // Wire up all "?" info toggles
  section.querySelectorAll('.brain-info-toggle').forEach(toggle => {
    let detail = toggle.nextElementSibling;
    if (!detail || !detail.classList.contains('brain-info-detail')) {
      detail = toggle.parentElement.nextElementSibling;
    }
    if (detail && detail.classList.contains('brain-info-detail')) {
      toggle.addEventListener('click', () => {
        const open = detail.style.display === 'none';
        detail.style.display = open ? 'block' : 'none';
      });
    }
  });

  // Scope toggle — only one active at a time
  scopeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      scopeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

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
  try {
    const { getEditToolbar } = await import('../editToolbar/index.js');
    const toolbar = getEditToolbar();
    if (toolbar) {
      toolbar.setEditMode(true);
    }
  } catch (e) {
    console.warn('BrainQuery: toolbar.setEditMode failed (non-fatal):', e);
  }

  // Autofocus (desktop only to avoid iOS keyboard issues)
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isMobile) {
    setTimeout(() => annotation.focus(), 150);
  }

  // Submit handler
  const handleSubmit = async () => {
    const question = annotation.textContent.trim();
    if (!question) {
      annotation.classList.add('brain-input-error');
      annotation.focus();
      annotation.addEventListener('input', () => {
        annotation.classList.remove('brain-input-error');
      }, { once: true });
      return;
    }

    // Disable input
    const sourceScope = section.querySelector('.brain-scope-btn.active').dataset.scope;
    annotation.contentEditable = 'false';
    submitBtn.disabled = true;
    cancelBtn.style.display = 'none';
    scopeBtns.forEach(b => b.disabled = true);

    statusEl.style.display = 'block';
    statusEl.textContent = 'Sending to archivist...';

    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    if (!csrfToken) {
      statusEl.textContent = 'Error: No CSRF token found';
      annotation.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
      scopeBtns.forEach(b => b.disabled = false);
      return;
    }

    brainRequestInFlight = true;

    const resetInputs = () => {
      annotation.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
      scopeBtns.forEach(b => b.disabled = false);
    };

    const showBillingError = (msg) => {
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
    };

    try {
      const response = await fetch('/api/ai-brain/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          selectedText,
          question,
          bookId,
          highlightId,
          nodeIds: Array.isArray(nodeIds) ? nodeIds : Object.keys(charData),
          charData,
          model: 'accounts/fireworks/models/deepseek-v3p2',
          sourceScope,
        }),
      });

      // Pre-stream errors (auth, billing, validation) come back as JSON
      if (!response.ok) {
        brainRequestInFlight = false;
        let data;
        try { data = await response.json(); } catch { data = {}; }
        const msg = data.message || 'AI query failed';
        if (response.status === 402) {
          showBillingError(msg);
        } else if (response.status === 504) {
          statusEl.textContent = 'The AI took too long. Please try again.';
        } else {
          statusEl.textContent = msg;
        }
        resetInputs();
        return;
      }

      // Read SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let data = null;
      let streamError = null;
      let eventType = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (eventType === 'status') {
                statusEl.textContent = parsed.message;
              } else if (eventType === 'error') {
                streamError = parsed.message || 'AI query failed';
              } else if (eventType === 'result') {
                data = parsed;
              }
            } catch (e) {
              console.warn('BrainQuery: failed to parse SSE data:', line);
            }
            eventType = 'message';
          }
        }
      }

      brainRequestInFlight = false;

      // Handle stream-level errors
      if (streamError) {
        statusEl.textContent = streamError;
        resetInputs();
        return;
      }

      if (!data || !data.success) {
        statusEl.textContent = (data && data.message) || 'AI query failed';
        resetInputs();
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

      // Force container to recalculate layout after replacing brain query form with sub-book content
      const container = document.getElementById('hyperlit-container');
      if (container) {
        const vv = window.visualViewport || { height: window.innerHeight, offsetTop: 0 };
        const topMargin = 16;
        const editToolbar2 = document.getElementById('edit-toolbar');
        const toolbarGap = editToolbar2 ? editToolbar2.offsetHeight : 4;
        const maxH = (vv.offsetTop || 0) + vv.height - topMargin - toolbarGap;
        container.style.maxHeight = `${maxH}px`;
      }

      // Success — highlight now has content, so it must persist.
      pendingBrainHighlightId = null;

    } catch (error) {
      brainRequestInFlight = false;
      console.error('BrainQuery: Fetch error:', error);
      statusEl.textContent = 'Network error. Try again.';
      resetInputs();
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
                credentials: 'same-origin',
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!resp.ok) {
                if (resp.status === 401) {
                    // Auth failed — the query may already be complete.
                    // Try loading the sub-book directly; on page reload
                    // Fix 1 (broadened gate) will skip polling if data exists.
                    statusEl.textContent = 'Session expired — please refresh the page.';
                    return;
                }
                statusEl.textContent = 'Error checking brain query status.';
                return;
            }

            const data = await resp.json();

            if (data.status === 'completed') {
                statusEl.textContent = 'Result ready — loading...';
                await updateHyperlightInIndexedDB(highlightId, data.sub_book_id, data.preview_nodes || [], data.raw_json || null);

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

                // Force container to recalculate layout after loading sub-book content
                const container = document.getElementById('hyperlit-container');
                if (container) {
                    const vv = window.visualViewport || { height: window.innerHeight, offsetTop: 0 };
                    const topMargin = 16;
                    const editToolbar = document.getElementById('edit-toolbar');
                    const toolbarGap = editToolbar ? editToolbar.offsetHeight : 4;
                    const maxH = (vv.offsetTop || 0) + vv.height - topMargin - toolbarGap;
                    container.style.maxHeight = `${maxH}px`;
                }
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
        raw_json: hyperlight.raw_json || { brain_query: true },
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
async function updateHyperlightInIndexedDB(highlightId, subBookId, previewNodes, rawJson = null) {
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
      if (rawJson !== null) {
        existing.raw_json = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
      }
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
