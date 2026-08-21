/**
 * Per-highlight visibility control — the book-style Public/Private picker
 * (trigger pill + frosted dropdown, same look as the source container's
 * visibility control) rendered inline in each hyperlight's author row, for the
 * highlight's creator only. Picking a state POSTs /api/db/sub-books/visibility,
 * which flips the annotation sub-book's library row: a private sub-book hides
 * the WHOLE highlight (mark + annotation) from everyone but its creator, even
 * in a public book. Encrypt is deliberately absent — E2EE is per root book
 * (sub-books share the root's DEK; the encryption endpoint rejects slash ids).
 *
 * Lifecycle: ButtonRegistry document-delegated singleton ('hyperlightVisibility'
 * in registerComponents.ts, containerDragger pattern) — one document click
 * listener that is inert unless a `.hl-visibility-control` is in the DOM, so it
 * survives container open/close and SPA nav without per-render wiring.
 */
import { openDatabase } from '../indexedDB/index';
import { PUBLIC_SVG, PRIVATE_SVG } from '../components/sourceContainer/helpers';
import { CHECK_SVG } from '../components/sourceContainer/visibilityControl';
import { setDefaultHighlightVisibility, type HighlightVisibility } from '../hyperlights/visibilityDefault';
import { trapModalFocus } from '../utilities/modalFocusTrap';
import { alertDialog } from '../components/dialog/dialog';
import { log } from '../utilities/logger';
import type { HyperlightRecord, LibraryRecord } from '../indexedDB/types';

const LOG_PATH = '/hyperlitContainer/hyperlightVisibilityControl.ts';

const STATE_ICON: Record<HighlightVisibility, string> = {
  public: PUBLIC_SVG,
  private: PRIVATE_SVG,
};
const STATE_LABEL: Record<HighlightVisibility, string> = {
  public: 'Public',
  private: 'Private',
};

/**
 * Pure builder for one control instance (interpolated into the container HTML by
 * displayHyperlights.ts). Class-addressed — NOT the source container's singleton
 * `id="visibility-control"` — with the instance identity in data attributes.
 */
export function buildHyperlightVisibilityControlHtml(
  highlightId: string,
  book: string,
  state: HighlightVisibility,
): string {
  const rows = (['public', 'private'] as HighlightVisibility[]).map((t) => `
      <button type="button" class="visibility-option${t === state ? ' active' : ''}" data-target="${t}">
        <span class="visibility-option-icon">${STATE_ICON[t]}</span>
        <span class="visibility-option-label">${STATE_LABEL[t]}</span>
        <span class="visibility-option-check">${CHECK_SVG}</span>
      </button>`).join('');

  return `<span class="hl-visibility-control visibility-control" data-state="${state}" data-highlight-id="${highlightId}" data-book="${book}">
      <button type="button" class="visibility-trigger" aria-haspopup="true" aria-expanded="false" title="Highlight visibility: ${STATE_LABEL[state]} — click to change">
        <span class="visibility-trigger-icon">${STATE_ICON[state]}</span>
        <svg class="visibility-chevron" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div class="visibility-panel" style="display: none;">${rows}
      </div>
    </span>`;
}

// ── Singleton open-panel state ─────────────────────────────────────────────
// At most one panel is open at a time; opening another closes the first.
let openControl: HTMLElement | null = null;
let openOverlay: HTMLElement | null = null;
let releaseTrap: (() => void) | null = null;
let outsideCloser: ((e: MouseEvent) => void) | null = null;

function closeOpenPanel(): void {
  const control = openControl;
  openControl = null;
  if (outsideCloser) {
    document.removeEventListener('click', outsideCloser, true);
    outsideCloser = null;
  }
  openOverlay?.remove();
  openOverlay = null;
  releaseTrap?.();
  releaseTrap = null;
  if (control) {
    const panel = control.querySelector<HTMLElement>('.visibility-panel');
    if (panel) panel.style.display = 'none';
    control.classList.remove('vis-open', 'vis-flip-left');
    control.querySelector('.visibility-trigger')?.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Pick which side the panel hangs off. It defaults to dropping rightward from the
 * trigger's left edge, but the control sits partway along the author row and the
 * container clips at `overflow: hidden` — on a phone (75vw wide) a 170px panel from a
 * control that far across runs off the edge and its labels get cut in half. Measure the
 * laid-out panel against the container's clip box and flip it leftward when it spills.
 *
 * Flips back only if the flipped position ALSO fits: on a narrow container a panel
 * wider than the available room overflows either way, and left-aligned at least keeps
 * the icons (which carry the meaning) on screen.
 */
function orientPanel(control: HTMLElement, panel: HTMLElement, host: HTMLElement | null): void {
  control.classList.remove('vis-flip-left');
  if (!host) return;

  const GUTTER = 8;
  const clip = host.getBoundingClientRect();
  const dropped = panel.getBoundingClientRect();
  if (dropped.right <= clip.right - GUTTER) return; // fits as-is

  control.classList.add('vis-flip-left');
  const flipped = panel.getBoundingClientRect();
  if (flipped.left < clip.left + GUTTER) control.classList.remove('vis-flip-left');
}

function openPanel(control: HTMLElement): void {
  closeOpenPanel();
  openControl = control;
  const panel = control.querySelector<HTMLElement>('.visibility-panel');
  if (panel) panel.style.display = 'block';
  // NB: class is 'vis-open', NOT 'open' — a global bare `.open` button rule
  // (hyperlitEditButton.css) forces width/height:36px on anything class="open".
  control.classList.add('vis-open');
  control.querySelector('.visibility-trigger')?.setAttribute('aria-expanded', 'true');

  // Click-catcher over the container content (same class as the source-container
  // control, so the existing overlay CSS + overlaySurfaces inventory entry apply).
  // closest(), not getElementById: a highlight-in-a-highlight renders in a
  // STACKED layer (.hyperlit-container-stacked) — the overlay must cover the
  // layer the control actually lives in, not the base container beneath it.
  const host = control.closest<HTMLElement>('#hyperlit-container, .hyperlit-container-stacked');

  // Panel is already display:block, so it is laid out and measurable right here.
  if (panel) orientPanel(control, panel, host);

  if (host) {
    openOverlay = document.createElement('div');
    openOverlay.className = 'visibility-overlay';
    openOverlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!control.classList.contains('vis-busy')) closeOpenPanel();
    });
    host.appendChild(openOverlay);
  }

  // Capture-phase outside closer; also bails out if the container re-rendered
  // underneath us (control detached) while the panel was open.
  outsideCloser = (e: MouseEvent) => {
    if (!document.contains(control)) { closeOpenPanel(); return; }
    if (control.classList.contains('vis-busy')) return;
    if (!control.contains(e.target as Node)) closeOpenPanel();
  };
  document.addEventListener('click', outsideCloser, true);

  // Stacks above the hyperlit container's own trap (modalState) — Escape closes
  // just this panel, not the container.
  releaseTrap = trapModalFocus(control, {
    onEscape: () => { if (!control.classList.contains('vis-busy')) closeOpenPanel(); },
  });
}

/** Re-paint the trigger icon/title and the option rows' active markers. */
function renderControlState(control: HTMLElement, state: HighlightVisibility): void {
  const triggerIcon = control.querySelector('.visibility-trigger-icon');
  if (triggerIcon) triggerIcon.innerHTML = STATE_ICON[state];
  control.querySelector('.visibility-trigger')
    ?.setAttribute('title', `Highlight visibility: ${STATE_LABEL[state]} — click to change`);
  control.querySelectorAll<HTMLButtonElement>('.visibility-option').forEach((o) => {
    o.classList.toggle('active', o.dataset.target === state);
  });
}

/** Mirror the flip into IDB: the hyperlight record's wire field, and (best-effort)
 *  the sub-book's library row when it happens to be present locally. */
async function updateIdbRecords(
  book: string,
  highlightId: string,
  subBookId: string,
  visibility: HighlightVisibility,
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['hyperlights', 'library'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    const hlStore = tx.objectStore('hyperlights');
    const hlReq = hlStore.get([book, highlightId]);
    hlReq.onsuccess = () => {
      const record = hlReq.result as HyperlightRecord | undefined;
      if (record) {
        record.sub_book_visibility = visibility;
        hlStore.put(record);
      }
    };

    const libStore = tx.objectStore('library');
    const libReq = libStore.get(subBookId);
    libReq.onsuccess = () => {
      const record = libReq.result as LibraryRecord | undefined;
      if (record) {
        record.visibility = visibility;
        libStore.put(record);
      }
    };
  });
}

/** Run the flip: POST the new state, mirror to IDB, repaint, store the sticky default. */
async function applyHighlightVisibility(control: HTMLElement, target: HighlightVisibility): Promise<void> {
  const current = (control.dataset.state as HighlightVisibility) || 'public';
  if (target === current) { closeOpenPanel(); return; }
  if (control.classList.contains('vis-busy')) return;

  const book = control.dataset.book || '';
  const highlightId = control.dataset.highlightId || '';
  const option = control.querySelector<HTMLElement>(`.visibility-option[data-target="${target}"]`);
  const iconSpan = option?.querySelector('.visibility-option-icon');
  const prevIcon = iconSpan?.innerHTML ?? STATE_ICON[target];

  control.classList.add('vis-busy');
  if (iconSpan) iconSpan.innerHTML = '<span class="btn-spinner"></span>';
  control.querySelectorAll<HTMLButtonElement>('.visibility-option').forEach((o) => { o.disabled = true; });

  try {
    const csrfToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
    const response = await fetch('/api/db/sub-books/visibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({ parentBook: book, itemId: highlightId, visibility: target }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Visibility change failed: ${response.status} - ${errorText}`);
    }
    const result = await response.json();

    await updateIdbRecords(book, highlightId, result.subBookId, target);

    control.dataset.state = target;
    renderControlState(control, target);
    // Sticky default: the last visibility the user picked is what NEW highlights
    // are born with (hyperlights/database.ts reads it at creation).
    setDefaultHighlightVisibility(target);
    closeOpenPanel();
    log.user(`Highlight ${highlightId} visibility changed to ${target}`, LOG_PATH);
  } catch (error) {
    if (iconSpan) iconSpan.innerHTML = prevIcon;
    log.error('Highlight visibility change failed', LOG_PATH, error as any);
    await alertDialog({
      title: "Couldn't change visibility",
      message: (error as Error)?.message ?? 'Unknown error',
    });
  } finally {
    control.classList.remove('vis-busy');
    control.querySelectorAll<HTMLButtonElement>('.visibility-option').forEach((o) => { o.disabled = false; });
  }
}

// ── ButtonRegistry lifecycle (document-delegated singleton) ────────────────
let delegatedClickHandler: ((e: MouseEvent) => void) | null = null;

export function initHyperlightVisibility(): void {
  // Re-entry (SPA nav / registry re-init): clear stale open-panel state — the
  // container HTML it pointed at may be gone.
  closeOpenPanel();
  document.querySelectorAll('#hyperlit-container > .visibility-overlay, .hyperlit-container-stacked > .visibility-overlay')
    .forEach((el) => el.remove());

  if (delegatedClickHandler) return; // create-once: delegation is page-agnostic

  delegatedClickHandler = (e: MouseEvent) => {
    const eventTarget = e.target as Element | null;
    if (!eventTarget) return;

    const trigger = eventTarget.closest('.hl-visibility-control .visibility-trigger');
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      const control = trigger.closest<HTMLElement>('.hl-visibility-control')!;
      if (control.classList.contains('vis-busy')) return;
      if (control === openControl) closeOpenPanel(); else openPanel(control);
      return;
    }

    const option = eventTarget.closest<HTMLElement>('.hl-visibility-control .visibility-option');
    if (option) {
      e.preventDefault();
      e.stopPropagation();
      const control = option.closest<HTMLElement>('.hl-visibility-control')!;
      void applyHighlightVisibility(control, option.dataset.target as HighlightVisibility);
    }
  };
  document.addEventListener('click', delegatedClickHandler);
}

export function destroyHyperlightVisibility(): void {
  if (delegatedClickHandler) {
    document.removeEventListener('click', delegatedClickHandler);
    delegatedClickHandler = null;
  }
  closeOpenPanel();
}
