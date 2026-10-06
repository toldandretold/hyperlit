/**
 * selectionAutoScroll — stop the reader from racing/jumping because of scroll-padding-top.
 *
 * Root cause (measured, not guessed): `.reader-content-wrapper` carries
 * `scroll-padding-top: 192px` (needed for fragment-nav alignment — keep in sync with
 * headerOffset=192 in scrolling). The browser treats that top scroll-padding band as the
 * scrollport's out-of-bounds zone for every native scroll-into-view, which bites twice:
 *
 * 1. DRAG-SELECT: the native text-selection auto-scroll auto-scrolls UP whenever the pointer
 *    sits anywhere in the top ~192px of the scrollport, with velocity proportional to how deep
 *    into the band the pointer is. Verified empirically: |Δ per tick| === scrollPaddingTop −
 *    pointerY (e.g. 192 − 95 = 97; 192 − 170 = 22). Fires even on a sideways drag.
 *
 * 2. TYPING (edit mode): the UA's own "reveal the caret after input" is a scroll-into-view
 *    against the scrollport padding box, so with the caret anywhere in the top 192px a single
 *    keystroke scrolls the page until the caret sits 192px below the top — the whole page
 *    visibly jumps down. Same for caret keys (ArrowUp into the band).
 *
 * Fix: zero scroll-padding-top on the wrapper via an inline override while either a selection
 * drag is active (pointerdown → pointerup) or keyboard activity is live in a contentEditable
 * inside the reader (keydown + a short debounced hold). Restore it when both are idle so
 * fragment navigation keeps its 192px alignment the rest of the time. Our own JS navigation
 * (scrollElementWithConsistentMethod) does manual scrollTop math and never reads the CSS
 * padding, so it is unaffected either way.
 *
 * The two override sources are deliberately SEPARATE flags: chunk windowing consumes
 * isSelectionDragActive() as "a live cross-chunk selection exists, don't trim" — typing must
 * not masquerade as a drag or every keystroke would silently disable chunk trimming.
 *
 * Listener-bearing component → registered via ButtonRegistry (components/utilities/
 * registerComponents.ts), NOT a @vite side-effect or a top-level global singleton. It listens
 * on `document`, so one session instance survives SPA navigation; init just clears stale state.
 */

let initialized = false;
let overriddenEl: HTMLElement | null = null;
let dragActive = false;
let typingRestoreTimer: ReturnType<typeof setTimeout> | null = null;

/** How long after the last keystroke the padding override is held. keydown fires before the
 * input's DOM change, so the padding is already 0 when the UA computes its caret reveal; this
 * window just has to outlive that synchronous follow-up, and continuous typing keeps re-arming. */
const TYPING_HOLD_MS = 250;

function readerWrapperFrom(target: any): HTMLElement | null {
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest('.reader-content-wrapper');
}

function applyOverride(wrapper: HTMLElement): void {
  wrapper.style.scrollPaddingTop = '0px';
  overriddenEl = wrapper;
}

/** Restore the stylesheet padding — but only once BOTH override sources are idle. */
function restoreIfIdle(): void {
  if (dragActive || typingRestoreTimer !== null) return;
  if (overriddenEl) {
    overriddenEl.style.scrollPaddingTop = ''; // revert to the stylesheet value (192px)
    overriddenEl = null;
  }
}

function clearTypingHold(): void {
  if (typingRestoreTimer !== null) {
    clearTimeout(typingRestoreTimer);
    typingRestoreTimer = null;
  }
}

function onPointerDown(e: PointerEvent): void {
  // Primary button / primary pointer only (ignore right-click, middle-click).
  if (e.button !== 0) return;
  const wrapper = readerWrapperFrom(e.target);
  if (!wrapper) return;
  // Collapse the native selection auto-scroll's oversized top trigger band for the duration
  // of this drag.
  dragActive = true;
  applyOverride(wrapper);
}

function onPointerEnd(): void {
  dragActive = false;
  restoreIfIdle();
}

function onKeyDown(e: KeyboardEvent): void {
  // Edit-mode only: a caret reveal needs a caret. Read-mode keystrokes don't mutate the DOM,
  // and read-mode scroll keys (Space/PageDown) SHOULD keep normal scroll behaviour.
  const target = e.target as HTMLElement | null;
  if (!target || !target.isContentEditable) return;
  const wrapper = readerWrapperFrom(target);
  if (!wrapper) return;
  applyOverride(wrapper);
  clearTypingHold();
  typingRestoreTimer = setTimeout(() => {
    typingRestoreTimer = null;
    restoreIfIdle();
  }, TYPING_HOLD_MS);
}

function onWindowBlur(): void {
  // Safety net: a lost pointerup (pointer left the window) or a tab switch mid-typing must not
  // leave the padding zeroed indefinitely.
  dragActive = false;
  clearTypingHold();
  restoreIfIdle();
}

/**
 * Is a text-selection drag currently active inside the reader? True between a primary-button
 * `pointerdown` in `.reader-content-wrapper` and the matching `pointerup`/cancel. Reused by the
 * chunk-windowing logic so it never removes a chunk out from under a live cross-chunk selection.
 * Deliberately EXCLUDES the typing override — typing must not suppress chunk trimming.
 */
export function isSelectionDragActive(): boolean {
  return dragActive;
}

export function initSelectionAutoScroll(): void {
  // ButtonRegistry re-runs init on every reader entry. The document-level listeners survive
  // SPA navigation, so attach them once and just clear any stale override on re-entry.
  dragActive = false;
  clearTypingHold();
  restoreIfIdle();
  if (initialized) return;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onWindowBlur);
  initialized = true;
}

export function destroySelectionAutoScroll(): void {
  // Keep the page-agnostic document listeners alive across SPA nav (inert outside the reader
  // wrapper); just clear any stale override so the next reader entry starts clean.
  dragActive = false;
  clearTypingHold();
  restoreIfIdle();
}
