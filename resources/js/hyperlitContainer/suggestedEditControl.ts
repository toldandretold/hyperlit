/**
 * Suggested-edit UI for the hyperlit container — the ✎ button on a highlight's
 * blockquote, the per-node suggestion editor, the before/after diff rendering,
 * and the book owner's Accept / Like / Reject row.
 *
 * The whole surface lives INSIDE the highlight's existing
 * `<blockquote class="highlight-text">` (the one element this module repaints),
 * built from the IDB HyperlightRecord — never from the blockquote's own text,
 * which is a 140-char truncated copy. Data/service layer:
 * hyperlights/suggestedEdit.ts (+ suggestedEditAccept.ts for the splice).
 *
 * Lifecycle: ButtonRegistry document-delegated singleton ('suggestedEdit' in
 * registerComponents.ts, hyperlightVisibility pattern) — one document click
 * listener, inert unless a suggestion element is under the click, so it
 * survives container open/close and SPA nav with zero per-render wiring.
 */
import DOMPurify from 'dompurify';
import {
  getHighlightRecord,
  getSuggestionSegments,
  saveSuggestion,
  withdrawSuggestion,
  resolveSuggestion,
  reopenSuggestion,
} from '../hyperlights/suggestedEdit';
import { acceptSuggestion, revertSuggestion } from '../hyperlights/suggestedEditAccept';
import { diffWords, renderDiffHtml } from '../utilities/textDiff';
import { confirmDialog, alertDialog } from '../components/dialog/dialog';
import { log } from '../utilities/logger';
import type { HyperlightRecord, SuggestedEditPair } from '../indexedDB/types';

const LOG_PATH = '/hyperlitContainer/suggestedEditControl.ts';

const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;

// Only the BOOK OWNER can resolve a suggestion, so a `liked` status always
// means the book's author endorsed it — attribute it, because an author's like
// is a stronger signal than a generic one.
const STATUS_LABEL: Record<string, string> = {
  accepted: '✓ Edit accepted',
  rejected: 'Edit declined',
  liked: '♥ Liked by the author',
};

export interface HighlightBlockOptions {
  /** Viewer is the highlight's creator (is_user_highlight / local fallback). */
  isUserHighlight: boolean;
  /** Viewer can edit the BOOK the highlight marks (bookPermissions). */
  canEditBook: boolean;
  /** Current contenteditable state for the plain blockquote (editMode). */
  contentEditable: boolean;
  /** data-user-can-edit for the plain blockquote. */
  canEdit: boolean;
}

const escapeText = (text: string): string => DOMPurify.sanitize(text, { ALLOWED_TAGS: [] });

function truncated(text: string): string {
  const raw = text.length > 140 ? text.substring(0, 140) + '...' : text;
  return escapeText(raw);
}

/** One segment's before→after diff block (escaped by renderDiffHtml). */
function segmentDiffHtml(pair: SuggestedEditPair): string {
  return `<div class="suggestion-segment-diff">${renderDiffHtml(diffWords(pair.before, pair.after))}</div>`;
}

function suggestionDiffInnerHtml(record: HyperlightRecord): string {
  const map = record.suggested_text ?? {};
  const order = (record.node_id ?? []).filter((id) => map[id]);
  const keys = order.length ? order : Object.keys(map);
  return keys.map((id) => segmentDiffHtml(map[id]!)).join('');
}

/**
 * One combined action row. A viewer can be BOTH owner and suggester (a
 * self-suggestion — e.g. an MCP agent acting as the user proposed an edit on
 * the user's own book), so the roles compose: owner → Accept / ♥ Like /
 * Decline, suggester → re-edit ✎ + Withdraw. The ♥ is an ENDORSEMENT ("good
 * suggestion, but I'll keep the original") and is offered to the owner on
 * EVERY suggestion including their own draft — the author liking it is a
 * meaningful signal, not self-flattery.
 */
function pendingActionsHtml(opts: HighlightBlockOptions): string {
  const buttons: string[] = [];
  if (opts.canEditBook) {
    buttons.push(`<button type="button" class="suggestion-action suggestion-accept" data-action="accept" title="Accept — replace the passage in your book with this edit">Accept</button>`);
    buttons.push(`<button type="button" class="suggestion-action suggestion-like" data-action="liked" title="Like — a good suggestion, but keep the passage as it is">♥</button>`);
    buttons.push(`<button type="button" class="suggestion-action suggestion-reject" data-action="rejected" title="Decline this edit">Decline</button>`);
  }
  if (opts.isUserHighlight) {
    // Labeled, not the bare pencil: inside the pill row the icon-button sizing
    // rules collapse the svg to nothing (the invisible-circle bug).
    buttons.push(`<button type="button" class="suggestion-action suggestion-reedit" title="Edit your suggestion">Edit</button>`);
    buttons.push(`<button type="button" class="suggestion-action suggestion-withdraw" title="Withdraw your suggestion">Withdraw</button>`);
  }
  if (!buttons.length) return '';
  return `<div class="suggestion-actions" contenteditable="false">
      ${buttons.join('\n      ')}
    </div>`;
}

/**
 * The full blockquote HTML for a highlight, across every suggestion state.
 * Called by displayHyperlights at container build, and by this module's own
 * repaint after save / withdraw / resolve.
 */
export function buildHighlightTextBlockHtml(record: HyperlightRecord, opts: HighlightBlockOptions): string {
  const hlId = record.hyperlight_id;
  const status = record.suggestion_status ?? null;
  const hasPairs = !!record.suggested_text && Object.keys(record.suggested_text).length > 0;

  // PENDING — everyone sees the before/after diff instead of the plain quote.
  if (status === 'pending' && hasPairs) {
    return `  <blockquote class="highlight-text suggestion-diff" contenteditable="false" data-user-can-edit="false" data-highlight-id="${hlId}" data-content-id="${hlId}">
    <span class="suggestion-chip" contenteditable="false">Suggested edit</span>
    ${suggestionDiffInnerHtml(record)}${pendingActionsHtml(opts)}
  </blockquote>
`;
  }

  // RESOLVED — KEEP the suggestion framing: the before/after diff stays VISIBLE
  // with a status badge where the action row was, so a liked/declined/accepted
  // suggestion still plainly reads as a suggested edit (and shows WHAT was
  // suggested), not a bare highlight wearing a pill. An ACCEPTED edit stays
  // undoable: the book owner gets Revert (splice the replacement back out; the
  // suggestion returns to pending).
  if (status && hasPairs) {
    // The owner can undo any verdict back to pending. accepted → Revert
    // (splices the book text back); rejected/liked → Reconsider (nothing was
    // applied, so just reopen). Both return to the full Accept/Like/Decline row.
    let resolvedActions = '';
    if (opts.canEditBook) {
      if (status === 'accepted') {
        resolvedActions = `<div class="suggestion-actions" contenteditable="false">
      <button type="button" class="suggestion-action suggestion-revert" title="Undo this edit — restore the original passage; the suggestion returns to pending">Revert</button>
    </div>`;
      } else if (status === 'rejected' || status === 'liked') {
        resolvedActions = `<div class="suggestion-actions" contenteditable="false">
      <button type="button" class="suggestion-action suggestion-reopen" title="Reconsider — reopen this suggestion to decide again">Reconsider</button>
    </div>`;
      }
    }
    const revertBtn = resolvedActions;
    return `  <blockquote class="highlight-text suggestion-diff suggestion-resolved-${status}" contenteditable="false" data-user-can-edit="false" data-highlight-id="${hlId}" data-content-id="${hlId}">
    <span class="suggestion-chip" contenteditable="false">Suggested edit</span>
    <span class="suggestion-badge suggestion-badge-${status}" contenteditable="false">${STATUS_LABEL[status] ?? status}</span>
    ${suggestionDiffInnerHtml(record)}${revertBtn}
  </blockquote>
`;
  }

  // PLAIN — today's blockquote, plus the ✎ for the highlight's creator —
  // INCLUDING on their own book (a self-suggestion is a staged edit you can
  // draft now and accept later, and the shape an MCP agent acting as the
  // user produces). Never on a ghosted anchor (nothing left to edit).
  const ghosted = Object.values(record.charData ?? {}).some((r) => r && r.charStart < 0);
  const offerSuggest = opts.isUserHighlight && !ghosted;
  const suggestBtn = offerSuggest
    ? `<button type="button" class="suggest-edit-btn" contenteditable="false" data-highlight-id="${hlId}" title="Suggest an edit to this passage">${PENCIL_SVG}</button>`
    : '';
  return `  <blockquote class="highlight-text" contenteditable="${opts.contentEditable}" data-user-can-edit="${opts.canEdit}" data-highlight-id="${hlId}" data-content-id="${hlId}">
    "${truncated(record.highlightedText)}"${suggestBtn}
  </blockquote>
`;
}

// ── Editor (✎ open → full-container editing mode) ──────────────────────────
//
// The editor takes over the hyperlit container: the textareas go full width
// and tall, the host gets `.suggestion-editing-mode` (which hides the normal
// edit button + nav arrows), and Save/Cancel live in a bar pinned to the
// CONTAINER's bottom edge — not squeezed under a drag-resize textarea.

/** Remove any editing chrome (bottom bar + host class), everywhere. */
function closeEditorChrome(): void {
  document.querySelectorAll('.suggestion-editor-bar').forEach((bar) => bar.remove());
  document.querySelectorAll('.suggestion-editing-mode').forEach((host) => {
    host.classList.remove('suggestion-editing-mode');
  });
}

async function openEditor(blockquote: HTMLElement, highlightId: string): Promise<void> {
  const record = await getHighlightRecord(highlightId);
  if (!record) return;
  const segments = await getSuggestionSegments(record);
  if (!segments.length) return;

  const rows = segments.map((segment) => {
    if (!segment.editable) {
      return `<div class="suggestion-segment suggestion-segment-locked" data-node-id="${segment.nodeId}">
          <span class="suggestion-locked-text">${escapeText(segment.originalText || '(unavailable)')}</span>
          <span class="suggestion-locked-reason">${escapeText(segment.reason ?? '')}</span>
        </div>`;
    }
    return `<textarea class="suggestion-segment" data-node-id="${segment.nodeId}" rows="3">${escapeText(segment.suggestedText)}</textarea>`;
  }).join('');

  closeEditorChrome(); // one editor at a time

  blockquote.classList.add('suggestion-editing');
  blockquote.setAttribute('contenteditable', 'false');
  blockquote.setAttribute('data-user-can-edit', 'false');
  blockquote.innerHTML = `
    <span class="suggestion-chip" contenteditable="false">Suggest an edit</span>
    <div class="suggestion-editor" contenteditable="false">${rows}</div>`;

  const host = blockquote.closest<HTMLElement>('#hyperlit-container, .hyperlit-container-stacked');
  if (host) {
    host.classList.add('suggestion-editing-mode');
    const bar = document.createElement('div');
    bar.className = 'suggestion-editor-bar';
    bar.dataset.highlightId = highlightId;
    bar.innerHTML = `
      <button type="button" class="suggestion-action suggestion-save">Save suggestion</button>
      <button type="button" class="suggestion-action suggestion-cancel">Cancel</button>`;
    host.appendChild(bar);
  } else {
    // No container host (unexpected) — keep the buttons inline so the editor
    // is never save-less.
    blockquote.querySelector('.suggestion-editor')?.insertAdjacentHTML('beforeend', `
      <div class="suggestion-actions">
        <button type="button" class="suggestion-action suggestion-save">Save suggestion</button>
        <button type="button" class="suggestion-action suggestion-cancel">Cancel</button>
      </div>`);
  }

  blockquote.scrollIntoView({ block: 'start', behavior: 'auto' });
  blockquote.querySelector<HTMLTextAreaElement>('textarea.suggestion-segment')?.focus();
}

/** Re-render one highlight's blockquote from its current IDB record. */
async function repaintBlock(blockquote: HTMLElement, highlightId: string): Promise<void> {
  const record = await getHighlightRecord(highlightId);
  if (!record) return;

  const { getAuthContextSync, getAuthContext, canUserEditBook } = await import('../utilities/auth/index');
  const auth = getAuthContextSync() || await getAuthContext();
  const currentUser = auth?.user;
  const isUserHighlight = record.is_user_highlight === true
    || !!(currentUser && record.creator && (
      record.creator === currentUser.name
      || record.creator === currentUser.username
      || record.creator === currentUser.email))
    || (!record.creator && record.creator_token === auth?.userId);
  const canEditBook = !!(await canUserEditBook(record.book));

  const template = document.createElement('template');
  template.innerHTML = buildHighlightTextBlockHtml(record, {
    isUserHighlight,
    canEditBook,
    // Repaint lands in whatever mode the container is in; the plain state's
    // contenteditable is re-driven by editMode's toggle, so default to off.
    contentEditable: false,
    canEdit: isUserHighlight,
  }).trim();
  const fresh = template.content.firstElementChild as HTMLElement | null;
  if (fresh) blockquote.replaceWith(fresh);
}

// ── Click actions ──────────────────────────────────────────────────────────

async function handleSave(blockquote: HTMLElement, highlightId: string): Promise<void> {
  const afterByNode: Record<string, string> = {};
  blockquote.querySelectorAll<HTMLTextAreaElement>('textarea.suggestion-segment').forEach((area) => {
    const nodeId = area.dataset.nodeId;
    if (nodeId) afterByNode[nodeId] = area.value;
  });
  const result = await saveSuggestion(highlightId, afterByNode);
  if (result === 'withdrawn') {
    log.user(`Suggestion editor saved no changes for ${highlightId} — withdrawn`, LOG_PATH);
  }
  closeEditorChrome();
  await repaintBlock(blockquote, highlightId);
}

async function handleAccept(blockquote: HTMLElement, highlightId: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: 'Accept this edit?',
    message: 'The highlighted passage in your book will be replaced with the suggested text. Any footnote markers inside the replaced text are removed. You can restore earlier text from version history.',
  });
  if (!confirmed) return;

  const outcome = await acceptSuggestion(highlightId);
  if (outcome.status === 'blocked') {
    await alertDialog({ title: "Can't accept right now", message: outcome.reason });
    return;
  }
  if (outcome.skipped.length) {
    await alertDialog({
      title: 'Accepted with skips',
      message: `Some parts were not applied: ${outcome.skipped.map((s) => s.reason).join('; ')}`,
    });
  }
  await repaintBlock(blockquote, highlightId);
}

async function handleResolve(blockquote: HTMLElement, highlightId: string, resolution: 'rejected' | 'liked'): Promise<void> {
  const record = await getHighlightRecord(highlightId);
  if (!record) return;
  await resolveSuggestion(record.book, highlightId, resolution);
  await repaintBlock(blockquote, highlightId);
}

async function handleReopen(blockquote: HTMLElement, highlightId: string): Promise<void> {
  const record = await getHighlightRecord(highlightId);
  if (!record) return;
  await reopenSuggestion(record.book, highlightId);
  await repaintBlock(blockquote, highlightId);
}

async function handleRevert(blockquote: HTMLElement, highlightId: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: 'Revert this edit?',
    message: 'The passage in your book goes back to its original text, and the suggestion returns to pending for you to re-decide.',
  });
  if (!confirmed) return;

  const outcome = await revertSuggestion(highlightId);
  if (outcome.status === 'blocked') {
    await alertDialog({ title: "Can't revert right now", message: outcome.reason });
    return;
  }
  if (outcome.skipped.length) {
    await alertDialog({
      title: 'Reverted with skips',
      message: `Some parts were not restored: ${outcome.skipped.map((s) => s.reason).join('; ')}`,
    });
  }
  await repaintBlock(blockquote, highlightId);
}

// ── ButtonRegistry lifecycle (document-delegated singleton) ────────────────

let delegatedClickHandler: ((e: MouseEvent) => void) | null = null;

function withBusy(blockquote: HTMLElement, work: () => Promise<void>): void {
  if (blockquote.dataset.busy === 'true') return;
  blockquote.dataset.busy = 'true';
  void work()
    .catch(async (error) => {
      log.error('Suggested-edit action failed', LOG_PATH, error);
      await alertDialog({
        title: 'Something went wrong',
        message: (error as Error)?.message ?? 'Unknown error',
      });
    })
    .finally(() => {
      delete blockquote.dataset.busy;
    });
}

export function initSuggestedEdit(): void {
  // Re-entry (SPA nav / registry re-init): clear stale editing chrome — the
  // container HTML it pointed at may be gone.
  closeEditorChrome();

  if (delegatedClickHandler) return; // create-once: delegation is page-agnostic

  delegatedClickHandler = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;

    // Save/Cancel live in the bottom bar OUTSIDE the blockquote — resolve the
    // blockquote through the bar's highlight id within the same container.
    const bar = target.closest<HTMLElement>('.suggestion-editor-bar');
    if (bar) {
      e.preventDefault();
      e.stopPropagation();
      const barHlId = bar.dataset.highlightId ?? '';
      const host = bar.closest<HTMLElement>('#hyperlit-container, .hyperlit-container-stacked');
      const barBlockquote = barHlId
        ? host?.querySelector<HTMLElement>(`blockquote.highlight-text[data-highlight-id="${barHlId}"]`)
        : null;
      if (!barBlockquote) { closeEditorChrome(); return; }
      if (target.closest('.suggestion-save')) {
        withBusy(barBlockquote, () => handleSave(barBlockquote, barHlId));
      } else if (target.closest('.suggestion-cancel')) {
        withBusy(barBlockquote, async () => {
          closeEditorChrome();
          await repaintBlock(barBlockquote, barHlId);
        });
      }
      return;
    }

    const blockquote = target.closest<HTMLElement>('blockquote.highlight-text');
    if (!blockquote) return;
    const highlightId = blockquote.dataset.highlightId ?? '';
    if (!highlightId) return;

    const suggestBtn = target.closest('.suggest-edit-btn, .suggestion-reedit');
    if (suggestBtn) {
      e.preventDefault();
      e.stopPropagation();
      withBusy(blockquote, () => openEditor(blockquote, highlightId));
      return;
    }

    if (target.closest('.suggestion-save')) {
      e.preventDefault();
      e.stopPropagation();
      withBusy(blockquote, () => handleSave(blockquote, highlightId));
      return;
    }

    if (target.closest('.suggestion-cancel')) {
      e.preventDefault();
      e.stopPropagation();
      withBusy(blockquote, async () => {
        closeEditorChrome();
        await repaintBlock(blockquote, highlightId);
      });
      return;
    }

    if (target.closest('.suggestion-revert')) {
      e.preventDefault();
      e.stopPropagation();
      withBusy(blockquote, () => handleRevert(blockquote, highlightId));
      return;
    }

    if (target.closest('.suggestion-reopen')) {
      e.preventDefault();
      e.stopPropagation();
      withBusy(blockquote, () => handleReopen(blockquote, highlightId));
      return;
    }

    if (target.closest('.suggestion-withdraw')) {
      e.preventDefault();
      e.stopPropagation();
      withBusy(blockquote, async () => {
        await withdrawSuggestion(highlightId);
        await repaintBlock(blockquote, highlightId);
      });
      return;
    }

    const action = target.closest<HTMLElement>('.suggestion-action[data-action]');
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      const verdict = action.dataset.action;
      if (verdict === 'accept') {
        withBusy(blockquote, () => handleAccept(blockquote, highlightId));
      } else if (verdict === 'rejected' || verdict === 'liked') {
        withBusy(blockquote, () => handleResolve(blockquote, highlightId, verdict));
      }
    }
  };
  document.addEventListener('click', delegatedClickHandler);
}

export function destroySuggestedEdit(): void {
  if (delegatedClickHandler) {
    document.removeEventListener('click', delegatedClickHandler);
    delegatedClickHandler = null;
  }
  closeEditorChrome();
}
