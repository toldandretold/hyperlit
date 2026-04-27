/**
 * gateFilter.js — Gate panel UI + annotation filter logic.
 *
 * Gate modes:
 *   "default" — hide AI highlights + empty-annotation highlights (hypercites unfiltered)
 *   "all"     — show everything
 *   "hideAll" — hide everything except the user's own annotations
 *   "custom"  — user picks restrictions (apply to both hyperlights and hypercites)
 *
 * Critical rule: a user's own highlights/hypercites ALWAYS pass through the gate.
 */

const STORAGE_KEY = 'hyperlit_gate_filter';

const DEFAULT_SETTINGS = {
  mode: 'default',
  custom: { hideAI: false, hideAnonymous: false, hideNoAnnotation: false },
};

// ─── Settings persistence ───────────────────────────────────────────────

export function getGateSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt — fall through */ }
  return { ...DEFAULT_SETTINGS, custom: { ...DEFAULT_SETTINGS.custom } };
}

function saveGateSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * Return the current gate settings as a URL query string fragment (no leading ? or &).
 * Returns empty string when no settings stored (server uses its default).
 * Used by fetch helpers to pass gate settings to the server.
 */
export function gateQueryParam() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return '';            // no setting stored — let server use its default
  return `gate=${encodeURIComponent(raw)}`;
}

/**
 * Append gate filter query param to a URL string.
 * Handles URLs with or without existing query params.
 */
export function appendGateParam(url) {
  const param = gateQueryParam();
  if (!param) return url;
  return url + (url.includes('?') ? '&' : '?') + param;
}

// ─── Client-side filter ─────────────────────────────────────────────────

/**
 * Check whether preview_nodes contain any real text (not just empty HTML scaffolding).
 * Sub-books get an empty `<p></p>` in preview_nodes on creation, so a simple
 * non-null / length > 0 check gives false positives.
 */
function hasPreviewContent(previewNodes) {
  if (!previewNodes || !Array.isArray(previewNodes) || previewNodes.length === 0) return false;
  return previewNodes.some(node => {
    if (!node.content) return false;
    const textOnly = node.content.replace(/<[^>]*>/g, '').trim();
    return textOnly.length > 0;
  });
}

/**
 * Filter an array of hyperlights or hypercites based on current gate settings.
 * Items where `is_user_highlight === true` (or `is_user_hypercite === true`)
 * always pass through — a user's own annotations are never gated.
 *
 * @param {Array} items — hyperlights or hypercites array
 * @param {'hyperlight'|'hypercite'} type
 * @returns {Array} filtered items
 */
export function applyGateFilter(items, type) {
  if (!items || items.length === 0) return items;

  const settings = getGateSettings();

  // "all" mode — nothing filtered
  if (settings.mode === 'all') return items;

  // "hideAll" mode — only the user's own annotations pass
  if (settings.mode === 'hideAll') return items.filter(item => {
    if (type === 'hyperlight' && item.is_user_highlight) return true;
    if (type === 'hypercite' && item.is_user_hypercite) return true;
    return false;
  });

  return items.filter(item => {
    // User's own annotations always pass
    if (type === 'hyperlight' && item.is_user_highlight) return true;
    if (type === 'hypercite' && item.is_user_hypercite) return true;

    if (settings.mode === 'default') {
      // Default mode: filter hyperlights only; hypercites pass
      if (type === 'hypercite') return true;

      // Hide AI-generated highlights
      if (item.creator?.startsWith('AIreview:')) return false;

      // Hide highlights with no annotation content (parse preview_nodes for real text)
      const hasContentDefault = (item.annotation && item.annotation !== '') || hasPreviewContent(item.preview_nodes);
      if (!hasContentDefault) return false;

      return true;
    }

    // Custom mode — apply user-selected restrictions to both types
    if (settings.mode === 'custom') {
      const { hideAI, hideAnonymous, hideNoAnnotation } = settings.custom;

      if (hideAI && item.creator?.startsWith('AIreview:')) return false;
      if (hideAnonymous && !item.creator) return false;
      if (hideNoAnnotation) {
        // For hyperlights, check annotation field + parse preview_nodes for real text
        if (type === 'hyperlight') {
          const hasContent = (item.annotation && item.annotation !== '') || hasPreviewContent(item.preview_nodes);
          if (!hasContent) return false;
        }
        // For hypercites, no annotation field — skip this check
      }

      return true;
    }

    return true;
  });
}

// ─── Re-apply annotations after gate change ─────────────────────────────

/**
 * Re-fetch annotations from server (now filtered by new gate prefs),
 * rebuild IndexedDB arrays, and reprocess visible highlight marks in DOM.
 */
export async function reapplyAnnotationsWithGate(bookId) {
  if (!bookId) {
    const mainContent = document.querySelector('.main-content');
    bookId = mainContent?.id;
  }
  if (!bookId) return;

  const { syncAnnotationsOnly } = await import('../postgreSQL.js');
  await syncAnnotationsOnly(bookId);

  // Gather visible node IDs from DOM (same pattern as initializePage.js:1212-1217)
  const visibleNodeIds = Array.from(
    document.querySelectorAll('[id]:not([data-chunk-id]):not(.sentinel)')
  )
    .filter(el => /^\d+$/.test(el.id))
    .map(el => el.id);

  if (visibleNodeIds.length === 0) return;

  const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../indexedDB/hydration/rebuild.js');
  const { getNodeChunksFromIndexedDB } = await import('../indexedDB/index.js');

  const allNodes = await getNodeChunksFromIndexedDB(bookId);
  const visibleDataNodeIDs = allNodes
    .filter(n => visibleNodeIds.includes(String(n.startLine)))
    .map(n => n.node_id)
    .filter(Boolean);

  if (visibleDataNodeIDs.length > 0) {
    const allNodesToRebuild = await getNodesByDataNodeIDs(visibleDataNodeIDs);
    const nodesToRebuild = allNodesToRebuild.filter(n => n.book === bookId);
    await rebuildNodeArrays(nodesToRebuild);
  }

  const { reprocessHighlightsForNodes } = await import('../hyperlights/deletion.js');
  await reprocessHighlightsForNodes(bookId, visibleNodeIds);
}

// ─── Gate panel UI ──────────────────────────────────────────────────────

/**
 * Render the gate settings sub-panel inside the bottom-up-container.
 *
 * @param {HTMLElement} container — the #bottom-up-container element
 * @param {object} currentSettings — current gate settings object
 * @param {object} callbacks — { onApply(settings), onCancel() }
 */
export function showGatePanel(container, currentSettings, callbacks) {
  // Working copy so we don't mutate until Apply
  const draft = {
    mode: currentSettings.mode,
    custom: { ...currentSettings.custom },
  };

  // Visual checkbox state: in default/all/hideAll modes, show what those modes imply
  const visualChecks = draft.mode === 'default'
    ? { hideAI: true, hideAnonymous: false, hideNoAnnotation: true }
    : draft.mode === 'all'
      ? { hideAI: false, hideAnonymous: false, hideNoAnnotation: false }
      : draft.mode === 'hideAll'
        ? { hideAI: true, hideAnonymous: true, hideNoAnnotation: true }
        : draft.custom;

  container.innerHTML = `
    <div class="gate-panel">
      <div class="gate-mode-selector">
        <button type="button" class="gate-mode-btn${draft.mode === 'default' ? ' active' : ''}" data-mode="default">Default</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'all' ? ' active' : ''}" data-mode="all">Show All</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'hideAll' ? ' active' : ''}" data-mode="hideAll">Hide All</button>
        <button type="button" class="gate-mode-btn${draft.mode === 'custom' ? ' active' : ''}" data-mode="custom">Custom</button>
      </div>

      <div class="gate-options${draft.mode === 'custom' ? '' : ' disabled'}">
        <div class="gate-options-heading">Restrict highlights &amp; hypercites from:</div>
        <label class="gate-option">
          <input type="checkbox" data-key="hideAI" ${visualChecks.hideAI ? 'checked' : ''} ${draft.mode !== 'custom' ? 'disabled' : ''}>
          <span>AI (like citation review)</span>
        </label>
        <label class="gate-option">
          <input type="checkbox" data-key="hideAnonymous" ${visualChecks.hideAnonymous ? 'checked' : ''} ${draft.mode !== 'custom' ? 'disabled' : ''}>
          <span>Anonymous users</span>
        </label>
        <label class="gate-option">
          <input type="checkbox" data-key="hideNoAnnotation" ${visualChecks.hideNoAnnotation ? 'checked' : ''} ${draft.mode !== 'custom' ? 'disabled' : ''}>
          <span>Highlights with no annotation</span>
        </label>
      </div>

      <div class="gate-actions">
        <button type="button" class="vibe-submit-btn gate-apply-btn">Apply</button>
        <button type="button" class="vibe-cancel-btn gate-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  // ── Wire up interactions ──

  const panel = container.querySelector('.gate-panel');

  // Mode selector
  panel.querySelectorAll('.gate-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      draft.mode = btn.dataset.mode;
      // Update active button
      panel.querySelectorAll('.gate-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update checkbox state based on mode
      const optionsDiv = panel.querySelector('.gate-options');
      const checkboxes = panel.querySelectorAll('.gate-option input[type="checkbox"]');

      if (draft.mode === 'custom') {
        optionsDiv.classList.remove('disabled');
        checkboxes.forEach(cb => { cb.disabled = false; });
      } else {
        optionsDiv.classList.add('disabled');
        checkboxes.forEach(cb => { cb.disabled = true; });

        // Default pre-checks AI + no annotation; All unchecks all
        if (draft.mode === 'default') {
          panel.querySelector('[data-key="hideAI"]').checked = true;
          panel.querySelector('[data-key="hideAnonymous"]').checked = false;
          panel.querySelector('[data-key="hideNoAnnotation"]').checked = true;
        } else if (draft.mode === 'all') {
          checkboxes.forEach(cb => { cb.checked = false; });
        } else if (draft.mode === 'hideAll') {
          checkboxes.forEach(cb => { cb.checked = true; });
        }
      }
    });
  });

  // Checkbox changes
  panel.querySelectorAll('.gate-option input').forEach(cb => {
    cb.addEventListener('change', () => {
      draft.custom[cb.dataset.key] = cb.checked;
    });
  });

  // Apply
  panel.querySelector('.gate-apply-btn').addEventListener('click', () => {
    // Sync checkbox state back for non-custom modes too (visual state)
    if (draft.mode === 'default') {
      draft.custom = { hideAI: true, hideAnonymous: false, hideNoAnnotation: true };
    } else if (draft.mode === 'all') {
      draft.custom = { hideAI: false, hideAnonymous: false, hideNoAnnotation: false };
    } else if (draft.mode === 'hideAll') {
      draft.custom = { hideAI: true, hideAnonymous: true, hideNoAnnotation: true };
    }
    callbacks.onApply(draft);
  });

  // Cancel
  panel.querySelector('.gate-cancel-btn').addEventListener('click', () => {
    callbacks.onCancel();
  });
}
