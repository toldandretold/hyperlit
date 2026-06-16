/**
 * gateFilter.ts — annotation filter logic (gate query params + client-side filter).
 * The gate settings panel UI now lives in settingsContainer/gate.ts.
 *
 * Gate modes:
 *   "default" — hide AI highlights + empty-annotation highlights (hypercites unfiltered)
 *   "all"     — show everything
 *   "hideAll" — hide everything except the user's own annotations
 *   "custom"  — user picks restrictions (apply to both hyperlights and hypercites)
 *
 * Critical rule: a user's own highlights/hypercites ALWAYS pass through the gate.
 */

// ─── Book-level gate defaults (set by book creator) ─────────────────────
let _bookGateDefaults: any = null;
export function setBookGateDefaults(defaults: any) { _bookGateDefaults = defaults; }
export function getBookGateDefaults() { return _bookGateDefaults; }

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

function saveGateSettings(settings: any) {
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
  try {
    const parsed = JSON.parse(raw);
    if (parsed.mode === 'default' && _bookGateDefaults) {
      parsed.bookDefaults = _bookGateDefaults;
    }
    return `gate=${encodeURIComponent(JSON.stringify(parsed))}`;
  } catch {
    return `gate=${encodeURIComponent(raw)}`;
  }
}

/**
 * Append gate filter query param to a URL string.
 * Handles URLs with or without existing query params.
 */
export function appendGateParam(url: any) {
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
function hasPreviewContent(previewNodes: any) {
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
export function applyGateFilter(items: any, type: any) {
  if (!items || items.length === 0) return items;

  const settings = getGateSettings();

  // "all" mode — nothing filtered
  if (settings.mode === 'all') return items;

  // "hideAll" mode — only the user's own annotations pass
  if (settings.mode === 'hideAll') return items.filter((item: any) => {
    if (type === 'hyperlight' && item.is_user_highlight) return true;
    if (type === 'hypercite' && item.is_user_hypercite) return true;
    return false;
  });

  return items.filter((item: any) => {
    // User's own annotations always pass
    if (type === 'hyperlight' && item.is_user_highlight) return true;
    if (type === 'hypercite' && item.is_user_hypercite) return true;

    if (settings.mode === 'default') {
      if (_bookGateDefaults) {
        // Book creator has set custom defaults — apply to both types
        const { hideAI, hideAnonymous, hideNoAnnotation } = _bookGateDefaults;
        if (hideAI && item.creator?.startsWith('AIreview:')) return false;
        if (hideAnonymous && !item.creator) return false;
        if (hideNoAnnotation && type === 'hyperlight') {
          const hasContent = (item.annotation && item.annotation !== '') || hasPreviewContent(item.preview_nodes);
          if (!hasContent) return false;
        }
        return true;
      }

      // Global default: filter hyperlights only; hypercites pass
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
export async function reapplyAnnotationsWithGate(bookId?: any) {
  if (!bookId) {
    const mainContent = document.querySelector('.main-content');
    bookId = mainContent?.id;
  }
  if (!bookId) return;

  const { syncAnnotationsOnly } = await import('../../indexedDB/serverSync');
  const syncResult = await syncAnnotationsOnly(bookId);

  if (!syncResult?.success) {
    console.error('❌ Gate reapply aborted: annotation sync failed', syncResult);
    return;
  }

  // Gather visible node IDs from DOM (same pattern as initializePage.js:1212-1217)
  const visibleNodeIds = Array.from(
    document.querySelectorAll('[id]:not([data-chunk-id]):not(.sentinel)')
  )
    .filter(el => /^\d+$/.test(el.id))
    .map(el => el.id);

  if (visibleNodeIds.length === 0) return;

  const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../../indexedDB/hydration/rebuild');
  const { getNodeChunksFromIndexedDB } = await import('../../indexedDB/index');

  // Read freshly-synced nodes from IndexedDB
  const allNodes = await getNodeChunksFromIndexedDB(bookId);
  const visibleDataNodeIDs = allNodes
    .filter(n => visibleNodeIds.includes(String(n.startLine)))
    .map(n => n.node_id)
    .filter(Boolean);

  if (visibleDataNodeIDs.length > 0) {
    const allNodesToRebuild = await getNodesByDataNodeIDs(visibleDataNodeIDs as any);
    const nodesToRebuild = allNodesToRebuild.filter(n => n.book === bookId);
    await rebuildNodeArrays(nodesToRebuild);
  }

  // Re-read nodes after rebuild so reprocessHighlightsForNodes uses the freshest data
  const freshNodes = await getNodeChunksFromIndexedDB(bookId);

  const { reprocessHighlightsForNodes } = await import('../../hyperlights/deletion');
  await reprocessHighlightsForNodes(bookId, visibleNodeIds, freshNodes);
}
