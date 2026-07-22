/**
 * containerSwap — replace the TOP stack layer's content in place, without
 * closing/reopening the container. The primitive behind the highlight
 * prev/next arrows and the see-all listing (highlightNav.ts).
 *
 * Modeled on the pause half of pushStackedLayer (index.ts) + the scoped
 * teardown half of _popTopLayerImpl (stack.ts), except the layer entry itself
 * survives: the container wrapper, .open class, overlay, masks and body
 * scroll-lock are never touched, so there is no close/open animation.
 *
 * Import discipline: statically imports lateral siblings that never import
 * this module back (stack, containerState, contentBuild, permissions,
 * postOpen, noteListener, containerListeners, subBook leaves). highlightNav —
 * the only caller — is itself only ever dynamically imported.
 */

import { log, verbose } from '../utilities/logger';
import { openDatabase } from '../indexedDB/core/connection';
import { flushPendingEdits } from '../utilities/pendingEditsRegistry';
import { containerState, resetModuleState } from './containerState';
import { getTopLayer, getCurrentContainer, getCurrentScroller, syncStackToHistoryState } from './stack';
import { resetSubBookState, destroySubBook } from './subBookActions';
import { subBookLoaders } from './subBookState';
import { detachNoteListeners } from './noteListener';
import { cleanupContainerListeners } from './containerListeners';
import { buildUnifiedContent } from './contentBuild';
import { checkIfUserHasAnyEditPermission } from './permissions';
import { handlePostOpenActions } from './postOpen';

export interface SwapOptions {
  /** true → new history entry (see-all, card clicks); false → replaceState (arrows). */
  pushHistoryEntry?: boolean;
  /** URL for the (new or replaced) entry, e.g. `/${bookSegment}#HL_x`. */
  urlOverride?: string | null;
  /** Stored on the layer's contentMetadata for restore-scroll. */
  anchorId?: string | null;
}

/** The contentMetadata field mapping used at layer push (index.ts) — kept identical. */
function serializeContentTypes(contentTypes: any[]): any[] {
  return contentTypes.map((ct: any) => ({
    type: ct.type,
    hyperciteId: ct.hyperciteId,
    highlightIds: ct.highlightIds,
    fnCountId: ct.fnCountId,
    elementId: ct.elementId,
    footnoteId: ct.footnoteId,
    referenceId: ct.referenceId,
    relationshipStatus: ct.relationshipStatus,
    parentBookId: ct.parentBookId || null,
    targetBook: ct.targetBook || null,
    targetSubBook: ct.targetSubBook || null,
    targetHyperciteId: ct.targetHyperciteId || null,
    targetUrl: ct.targetUrl || null,
    isHyperlightURL: ct.isHyperlightURL || false,
    isFootnoteURL: ct.isFootnoteURL || false,
    hlDepth: ct.hlDepth || 0,
  }));
}

/**
 * Swap the top layer's content. Returns false when there is no open layer or
 * another container operation is in flight.
 */
export async function swapTopLayerContent(
  contentTypes: any[],
  newHighlightIds: string[] = [],
  opts: SwapOptions = {},
): Promise<boolean> {
  const top = getTopLayer();
  const container = getCurrentContainer();
  const scroller = getCurrentScroller();
  if (!top || !container || !scroller) {
    verbose.nav('swapTopLayerContent: no open layer — ignoring', 'hyperlitContainer/containerSwap');
    return false;
  }
  if (containerState.isProcessingClick) return false;
  containerState.isProcessingClick = true;

  try {
    // Lazy core import mirrors stack.ts (avoids the core↔stack TDZ ring).
    const { getHyperlitEditMode, savePreviewNodes }: any = await import('./core.js');
    const inEditMode = getHyperlitEditMode();

    // ── 1. Flush any in-progress edits while the current DOM is intact ──
    if (inEditMode) {
      await flushPendingEdits();
      await savePreviewNodes();
    }
    detachNoteListeners();

    // ── 2. Teardown current content (container stays open) ──
    // stackPop: true → removes tracked listeners WITHOUT restoring the main
    // editor/toolbar (we're not closing).
    await cleanupContainerListeners({ stackPop: true });

    // Destroy only the sub-books mounted inside THIS container (the
    // _popTopLayerImpl scoping — a stacked layer below keeps its DOM).
    const idsInLayer: string[] = [];
    for (const [id, entry] of subBookLoaders) {
      if (entry?.containerDiv && container.contains(entry.containerDiv)) {
        idsInLayer.push(id);
      }
    }
    for (const id of idsInLayer) destroySubBook(id);

    // Reset module state for the fresh content, PRESERVING the two flags that
    // remember how to restore the main editor when the container finally
    // closes (a swap is not a close).
    const keepMainEditorWasActive = containerState.mainEditorWasActive;
    const keepPreviousIsEditing = containerState.previousIsEditing;
    resetModuleState();
    containerState.mainEditorWasActive = keepMainEditorWasActive;
    containerState.previousIsEditing = keepPreviousIsEditing;
    resetSubBookState();

    // The floating buttons are re-inserted by postOpen — remove stale copies.
    container.querySelector('.hyperlit-edit-btn')?.remove();
    container.querySelector('.hyperlit-nav-arrows')?.remove();

    // ── 3. Rebuild ──
    const db = await openDatabase();
    const hasAnyEditPermission = await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);
    const html = await buildUnifiedContent(contentTypes, newHighlightIds, db, getHyperlitEditMode());
    scroller.innerHTML = html;
    scroller.scrollTop = 0;

    // ── 4. Re-run post-open (sub-books, listeners, edit/nav buttons) ──
    // skipAutoFocus: arrow navigation must not yank focus into the annotation.
    // isContentSwap: the editor re-attach must NOT re-capture the main-editor
    // restore flags — window.isEditing is container-owned at this point, and
    // capturing it poisons previousIsEditing so a later close would put the
    // MAIN book into edit mode the user never had (the arrow edit-leak bug).
    await handlePostOpenActions(contentTypes, newHighlightIds, null, false, hasAnyEditPermission, true, db, { containerEl: container, isContentSwap: true });

    // ── 5. Stack + history bookkeeping ──
    top.contentMetadata = {
      contentTypes: serializeContentTypes(contentTypes),
      anchorId: opts.anchorId ?? null,
      newHighlightIds,
      timestamp: Date.now(),
    };
    // Keep the layer's URL snapshot in sync with the swap — a STACKED layer's
    // pop restores the address bar from newTop.savedUrl, which would otherwise
    // snap back to the highlight this layer was originally OPENED on.
    if (opts.urlOverride) top.savedUrl = opts.urlOverride;
    syncStackToHistoryState({
      pushHistoryEntry: opts.pushHistoryEntry ?? false,
      urlOverride: opts.urlOverride ?? null,
    });

    verbose.nav(`swapTopLayerContent: swapped to ${contentTypes.map((c: any) => c.type).join('+')}`, 'hyperlitContainer/containerSwap');
    return true;
  } catch (error) {
    log.error('swapTopLayerContent failed', 'hyperlitContainer/containerSwap.ts', error as any);
    return false;
  } finally {
    containerState.isProcessingClick = false;
  }
}
