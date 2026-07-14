/**
 * gateFilter.ts — annotation filter logic (gate query params + client-side filter).
 * The gate settings panel UI now lives in settingsContainer/gate.ts.
 *
 * Gate modes:
 *   "default" — hide AI annotations (both types) + empty-annotation highlights
 *   "all"     — show everything
 *   "hideAll" — hide everything except the user's own annotations
 *   "custom"  — user picks restrictions (apply to both hyperlights and hypercites)
 *
 * Critical rules:
 *   - A user's own highlights/hypercites ALWAYS pass through the gate.
 *   - PINNED hypercite ids (deep-link targets, session-scoped) ALWAYS pass — the server
 *     mirrors this via the `pinned=` query param so a gated/'single' target still arrives,
 *     renders and glows when someone follows a #hypercite_ link.
 *   - Foreign `relationshipStatus === 'single'` hypercites are dropped (mirror of the
 *     server's always-on singles filter) — but ONLY when `is_user_hypercite === false`
 *     explicitly; `undefined` (local/legacy records) is kept so a creator's fresh copy
 *     never vanishes.
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

// ─── Pinned hypercite ids (deep-link targets, session-scoped) ───────────
// Any #hypercite_ id the user navigates to gets pinned here so it survives the
// client gate AND rides every bulk fetch as `pinned=` (server exempts it from
// gate + singles filtering). FIFO-capped; sessionStorage so a tab's deep-link
// targets survive SPA nav + reloads but don't leak across sessions.

const PINNED_KEY = 'hyperlit_pinned_hypercites';
const PINNED_CAP = 20;
const HYPERCITE_ID_RE = /^hypercite_[A-Za-z0-9]+$/;

let _pinned: string[] | null = null;

function loadPinned(): string[] {
  if (_pinned) return _pinned;
  try {
    const raw = sessionStorage.getItem(PINNED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    _pinned = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && HYPERCITE_ID_RE.test(id)) : [];
  } catch {
    _pinned = [];
  }
  return _pinned;
}

/** Pin a deep-link hypercite target so gate/singles filtering never strips it this session. */
export function pinHypercite(id: string): void {
  if (!HYPERCITE_ID_RE.test(id)) return;
  const pinned = loadPinned();
  const existing = pinned.indexOf(id);
  if (existing !== -1) pinned.splice(existing, 1); // re-pin moves to freshest slot
  pinned.push(id);
  while (pinned.length > PINNED_CAP) pinned.shift(); // FIFO cap
  try {
    sessionStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
  } catch { /* storage full/unavailable — in-memory pin still works this page */ }
}

export function getPinnedHyperciteIds(): string[] {
  return [...loadPinned()];
}

function isPinnedHypercite(id: unknown): boolean {
  return typeof id === 'string' && loadPinned().includes(id);
}

/**
 * Return the pinned ids as a URL query fragment (no leading ? or &), or '' when none.
 * Emitted INDEPENDENTLY of gate settings — fresh users have no stored gate but a
 * followed deep link must still ride every refetch.
 */
export function pinnedQueryParam(): string {
  const pinned = loadPinned();
  if (pinned.length === 0) return '';
  return `pinned=${encodeURIComponent(pinned.join(','))}`;
}

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
 * Append gate filter + pinned-hypercite query params to a URL string.
 * Handles URLs with or without existing query params. Each param is
 * independently optional (a fresh user with no gate setting still sends pinned).
 */
export function appendGateParam(url: any) {
  const params = [gateQueryParam(), pinnedQueryParam()].filter(Boolean);
  if (params.length === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + params.join('&');
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

  // Singles mirror (defense-in-depth for stale IDB — the server is the primary filter):
  // a foreign 'single' hypercite is never shown. EXPLICIT `=== false` only — records with
  // `undefined` ownership (locally created, legacy embedded) are kept, so a creator's own
  // fresh copy can never vanish. Pinned deep-link targets are exempt.
  const dropForeignSingle = (item: any) =>
    type === 'hypercite' &&
    item.relationshipStatus === 'single' &&
    item.is_user_hypercite === false &&
    !isPinnedHypercite(item.hyperciteId);

  // "all" mode — nothing gate-filtered (singles rule still applies: it is not gate-wired)
  if (settings.mode === 'all') return items.filter((item: any) => !dropForeignSingle(item));

  // "hideAll" mode — only the user's own annotations (and pinned deep-link targets) pass
  if (settings.mode === 'hideAll') return items.filter((item: any) => {
    if (type === 'hyperlight' && item.is_user_highlight) return true;
    if (type === 'hypercite' && item.is_user_hypercite) return true;
    if (type === 'hypercite' && isPinnedHypercite(item.hyperciteId)) return true;
    return false;
  });

  return items.filter((item: any) => {
    // User's own annotations always pass
    if (type === 'hyperlight' && item.is_user_highlight) return true;
    if (type === 'hypercite' && item.is_user_hypercite) return true;

    // Pinned deep-link targets always pass
    if (type === 'hypercite' && isPinnedHypercite(item.hyperciteId)) return true;

    if (dropForeignSingle(item)) return false;

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

      // Global default: hide AI for BOTH types (parity with server applyGateFilters)
      if (item.creator?.startsWith('AIreview:')) return false;

      // Empty-annotation check is hyperlight-only (hypercites have no annotation)
      if (type === 'hyperlight') {
        const hasContentDefault = (item.annotation && item.annotation !== '') || hasPreviewContent(item.preview_nodes);
        if (!hasContentDefault) return false;
      }

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

  const { syncAnnotationsOnly } = await import('../../indexedDB/serverSync/index');
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
  const { getNodesFromIndexedDB } = await import('../../indexedDB/index');

  // Read freshly-synced nodes from IndexedDB
  const allNodes = await getNodesFromIndexedDB(bookId);
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
  const freshNodes = await getNodesFromIndexedDB(bookId);

  const { reprocessHighlightsForNodes } = await import('../../hyperlights/deletion');
  await reprocessHighlightsForNodes(bookId, visibleNodeIds, freshNodes);
}
