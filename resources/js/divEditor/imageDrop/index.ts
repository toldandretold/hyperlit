/**
 * Drag-and-drop image insertion for the divEditor (edit mode only).
 *
 * Lifecycle: attached by enableEditMode right after addPasteListener, removed
 * on edit-mode exit — so outside edit mode this module holds NO listeners and
 * a stray file drop keeps today's browser-default behaviour.
 *
 * While active it owns two hazards (fileDropTarget precedent):
 *  1. every file-drag `dragover` is preventDefault()ed — without it the
 *     browser NAVIGATES to a file dropped anywhere on the reader;
 *  2. `beforeinput` with inputType 'insertFromDrop' is swallowed — a native
 *     contenteditable drop would otherwise inject browser-authored markup
 *     (the paste listener only guards 'insertFromPaste').
 *
 * Visuals: an inert full-viewport hint (`image-drop-overlay`, registered in
 * overlaySurfacesInventory) + a thin insertion indicator bar at the
 * before/after boundary of the node under the pointer. Target resolution is
 * rAF-throttled `elementFromPoint` → resolveTopLevelNode → rect-midpoint —
 * block semantics, no caretRangeFromPoint needed.
 */
import { resolveTopLevelNode } from '../../utilities/nodeResolve';
import { asBookId, NUMERICAL_ID_PATTERN, type BookId } from '../../utilities/idHelpers';
import { verbose } from '../../utilities/logger';
import { insertImageFiles } from './insertImageFiles';

const OVERLAY_ID = 'image-drop-overlay';
const INDICATOR_ID = 'image-drop-indicator';

interface DropTarget {
  node: HTMLElement;
  position: 'before' | 'after';
}

let editableRef: HTMLElement | null = null;
let fallbackBookId: BookId | null = null;
let dragDepth = 0;
let rafPending = false;
let currentTarget: DropTarget | null = null;
let overlayEl: HTMLElement | null = null;
let indicatorEl: HTMLElement | null = null;
let onDragEnter: ((e: DragEvent) => void) | null = null;
let onDragOver: ((e: DragEvent) => void) | null = null;
let onDragLeave: ((e: DragEvent) => void) | null = null;
let onDrop: ((e: DragEvent) => void) | null = null;
let onBeforeInput: ((e: InputEvent) => void) | null = null;

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

function ensureOverlay(): HTMLElement {
  if (overlayEl) return overlayEl;
  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  // Inert hint banner — pointer-events none so drag events pass through to
  // the page; never obscures the drop point (unlike the centered import card).
  el.style.cssText = [
    'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2000', 'padding:0.5em 1.1em', 'border-radius:999px',
    'background:rgba(34,31,32,0.85)', 'color:#fff', 'font-size:0.9rem',
    'border:1px dashed #EF8D34', 'pointer-events:none', 'display:none',
    'white-space:nowrap',
  ].join(';');
  el.textContent = 'Drop image to insert it';
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

function ensureIndicator(): HTMLElement {
  if (indicatorEl) return indicatorEl;
  const el = document.createElement('div');
  el.className = INDICATOR_ID;
  el.style.cssText = [
    'position:fixed', 'height:3px', 'border-radius:2px',
    'background:#EF8D34', 'z-index:2001', 'pointer-events:none',
    'display:none',
  ].join(';');
  document.body.appendChild(el);
  indicatorEl = el;
  return el;
}

function hideVisuals(): void {
  if (overlayEl) overlayEl.style.display = 'none';
  if (indicatorEl) indicatorEl.style.display = 'none';
}

/** The contenteditable root the pointer is over (main editor or a sub-book). */
function resolveRootFor(el: Element): Element | null {
  const subBook = el.closest('[data-book-id][contenteditable="true"]');
  if (subBook) return subBook;
  if (editableRef && editableRef.contains(el)) return editableRef;
  return null;
}

function updateTarget(clientX: number, clientY: number): void {
  const indicator = ensureIndicator();
  const under = document.elementFromPoint(clientX, clientY);
  const root = under ? resolveRootFor(under) : null;
  const node = root ? resolveTopLevelNode(under, root) : null;

  if (!node || !node.id || !NUMERICAL_ID_PATTERN.test(node.id)) {
    currentTarget = null;
    indicator.style.display = 'none';
    return;
  }

  const rect = node.getBoundingClientRect();
  const position: DropTarget['position'] = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  currentTarget = { node, position };

  indicator.style.display = 'block';
  indicator.style.left = `${rect.left}px`;
  indicator.style.width = `${rect.width}px`;
  indicator.style.top = `${(position === 'before' ? rect.top : rect.bottom) - 1.5}px`;
}

async function handleDrop(files: File[], target: DropTarget): Promise<void> {
  const bookAttr = target.node.closest('[data-book-id]')?.getAttribute('data-book-id');
  const bookId = bookAttr ? asBookId(bookAttr) : fallbackBookId;
  if (!bookId) return;
  await insertImageFiles(files, target.node, target.position, bookId);
}

export function addImageDropListener(editableDiv: HTMLElement, bookId: string): void {
  removeImageDropListener();
  editableRef = editableDiv;
  fallbackBookId = asBookId(bookId);
  dragDepth = 0;
  rafPending = false;

  onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) ensureOverlay().style.display = 'block';
  };

  onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    // MUST preventDefault on every dragover or the browser navigates to the
    // dropped file (and the drop event never fires).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (rafPending) return;
    rafPending = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      rafPending = false;
      if (dragDepth > 0) updateTarget(clientX, clientY);
    });
  };

  onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideVisuals();
  };

  onDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    // Always claim the drop while in edit mode — even a miss (outside the
    // content) must not become a browser navigation.
    e.preventDefault();
    dragDepth = 0;

    // Snapshot BEFORE any await — the dataTransfer is dead after this tick.
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    // Resolve the target at the actual drop point (the rAF-throttled tracker
    // may lag a fast final move).
    updateTarget(e.clientX, e.clientY);
    const target = currentTarget;
    hideVisuals();
    currentTarget = null;

    if (!files.length || !target) return;
    void handleDrop(files, target);
  };

  onBeforeInput = (e: InputEvent) => {
    if (e.inputType === 'insertFromDrop') e.preventDefault();
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  editableDiv.addEventListener('beforeinput', onBeforeInput as EventListener);

  verbose.init('Image drop listener attached', 'divEditor/imageDrop');
}

export function removeImageDropListener(): void {
  if (onDragEnter) window.removeEventListener('dragenter', onDragEnter);
  if (onDragOver) window.removeEventListener('dragover', onDragOver);
  if (onDragLeave) window.removeEventListener('dragleave', onDragLeave);
  if (onDrop) window.removeEventListener('drop', onDrop);
  if (onBeforeInput && editableRef) editableRef.removeEventListener('beforeinput', onBeforeInput as EventListener);
  onDragEnter = onDragOver = onDragLeave = onDrop = null;
  onBeforeInput = null;
  overlayEl?.remove();
  indicatorEl?.remove();
  overlayEl = indicatorEl = null;
  editableRef = null;
  fallbackBookId = null;
  dragDepth = 0;
  rafPending = false;
  currentTarget = null;
}
