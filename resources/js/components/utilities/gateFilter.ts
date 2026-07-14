/**
 * gateFilter.ts — annotation filter logic (gate query params + client-side filter).
 * The gate settings panel UI now lives in settingsContainer/gate.ts.
 *
 * Gate modes (flags are PER-TYPE — Highlights column vs Hypercites column):
 *   "default" — highlights: hide AI + empty-annotation; hypercites: hide AI + anonymous
 *   "all"     — show everything
 *   "hideAll" — hide everything except the user's own annotations
 *   "custom"  — user picks restrictions per type (legacy flat shape = both types)
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
  custom: {
    hyperlight: { hideAI: false, hideAnonymous: false, hideNoAnnotation: false },
    hypercite: { hideAI: false, hideAnonymous: false },
  },
};

// ─── Per-type gate flags ────────────────────────────────────────────────
// The settings panel has a Highlights column and a Hypercites column; flags are
// stored per type. The legacy FLAT shape ({hideAI,...} — pre-split localStorage /
// users.preferences / library.gate_defaults) is still honored: it applies to both
// types. Server mirror: DatabaseToIndexedDBController::normalizeGateFlags().

export type GateFlags = { hideAI: boolean; hideAnonymous: boolean; hideNoAnnotation: boolean };
export type GateType = 'hyperlight' | 'hypercite';

/** What "Default" means globally, per type. Hypercites hide ANONYMOUS by default —
 *  an anonymous cite is a navigation funnel (can lead readers to spam books),
 *  unlike an anonymous highlight which is just an in-place mark. */
export const GLOBAL_DEFAULT_FLAGS: Record<GateType, GateFlags> = {
  hyperlight: { hideAI: true, hideAnonymous: false, hideNoAnnotation: true },
  hypercite: { hideAI: true, hideAnonymous: true, hideNoAnnotation: false },
};

/** AI creators: 'AIreview:*' = citation review (highlights); 'AIarchivist' = the AI
 *  Archivist (the one that mints hypercites). Server mirror in applyGateFilters(). */
export function isAiCreator(creator: unknown): boolean {
  return typeof creator === 'string'
    && (creator.startsWith('AIreview:') || creator.startsWith('AIarchivist'));
}

/** Normalize a nested-per-type OR legacy-flat flag object to one type's triple. */
export function normalizeGateFlags(flags: any, type: GateType): GateFlags {
  const empty: GateFlags = { hideAI: false, hideAnonymous: false, hideNoAnnotation: false };
  if (!flags || typeof flags !== 'object') return empty;
  if ('hyperlight' in flags || 'hypercite' in flags) {
    flags = flags[type] || {};
    if (typeof flags !== 'object') return empty;
  }
  return {
    hideAI: !!flags.hideAI,
    hideAnonymous: !!flags.hideAnonymous,
    hideNoAnnotation: !!flags.hideNoAnnotation,
  };
}

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

/**
 * Clear every pinned deep-link exemption. Called when the user APPLIES gate settings:
 * a pin encodes "I followed a link here" intent, but an explicit gate change is more
 * recent intent and must win — otherwise Hide All can never hide a once-visited cite
 * (it would re-exempt itself via pinned= on every fetch until the cache is cleared).
 * Re-following a link simply pins it again.
 */
export function clearPinnedHypercites(): void {
  _pinned = [];
  try {
    sessionStorage.removeItem(PINNED_KEY);
  } catch { /* storage unavailable — in-memory clear still applies */ }
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
  return structuredClone(DEFAULT_SETTINGS);
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

    // default and custom both resolve to a per-type flag triple (mirrors the server:
    // book defaults > global per-type defaults; nested and legacy-flat shapes accepted)
    let flags: GateFlags | null = null;
    if (settings.mode === 'default') {
      flags = _bookGateDefaults
        ? normalizeGateFlags(_bookGateDefaults, type as GateType)
        : GLOBAL_DEFAULT_FLAGS[type as GateType];
    } else if (settings.mode === 'custom') {
      flags = normalizeGateFlags(settings.custom, type as GateType);
    }
    if (flags) {
      if (flags.hideAI && isAiCreator(item.creator)) return false;
      if (flags.hideAnonymous && !item.creator) return false;
      // Empty-annotation check is hyperlight-only (hypercites have no annotation)
      if (flags.hideNoAnnotation && type === 'hyperlight') {
        const hasContent = (item.annotation && item.annotation !== '') || hasPreviewContent(item.preview_nodes);
        if (!hasContent) return false;
      }
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
