/**
 * Brain Query module — renders a question input inside the hyperlit container,
 * sends the query to the AI Brain API, and renders the response as sub-book content.
 */

import { buildSubBookId } from '../utilities/subBookIdHelper.js';

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

      statusTimers.forEach(t => clearTimeout(t));

      const data = await response.json();

      if (!response.ok || !data.success) {
        const msg = data.message || 'AI query failed';
        statusEl.textContent = msg;
        annotation.contentEditable = 'true';
        submitBtn.disabled = false;
        cancelBtn.style.display = '';
        return;
      }

      // Success — clear scroller for sub-book content
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

    } catch (error) {
      statusTimers.forEach(t => clearTimeout(t));
      console.error('BrainQuery: Fetch error:', error);
      statusEl.textContent = 'Network error. Try again.';
      annotation.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
    }
  };

  submitBtn.addEventListener('click', handleSubmit);

  // Cancel handler — delete the highlight and close container
  cancelBtn.addEventListener('click', async () => {
    const { deleteHighlightById } = await import('../hyperlights/deletion.js');
    await deleteHighlightById(highlightId);
    const { closeHyperlitContainer } = await import('./core.js');
    await closeHyperlitContainer();
  });
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
