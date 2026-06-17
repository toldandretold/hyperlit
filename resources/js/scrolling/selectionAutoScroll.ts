/**
 * selectionAutoScroll — stop the reader from racing upward while drag-selecting.
 *
 * Root cause (measured, not guessed): `.reader-content-wrapper` carries
 * `scroll-padding-top: 192px` (needed for fragment-nav alignment — keep in sync with
 * headerOffset=192 in scrolling). The browser's native text-selection auto-scroll treats that
 * top scroll-padding band as the "scroll-into-view" zone, so during a selection drag it
 * auto-scrolls UP whenever the pointer sits anywhere in the top ~192px of the scrollport, with
 * velocity proportional to how deep into the band the pointer is. Verified empirically:
 * |Δ per tick| === scrollPaddingTop − pointerY (e.g. 192 − 95 = 97; 192 − 170 = 22). The
 * effect fires even on a sideways drag — merely having the pointer in that band while selecting
 * is enough.
 *
 * Fix: while a selection drag is active (pointer down inside the reader content), zero
 * scroll-padding-top on the wrapper via an inline override; restore it on pointer release so
 * fragment navigation keeps its 192px alignment the rest of the time. scroll-padding only
 * affects scroll-snap / scrollIntoView / fragment scrolling — none of which happen mid-drag —
 * so removing it for the duration of the drag is safe and changes nothing else.
 *
 * Listener-bearing component → registered via ButtonRegistry (components/utilities/
 * registerComponents.ts), NOT a @vite side-effect or a top-level global singleton. It listens
 * on `document`, so one session instance survives SPA navigation; init just clears stale state.
 */

let initialized = false;
let overriddenEl: HTMLElement | null = null;

function readerWrapperFrom(target: any): HTMLElement | null {
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest('.reader-content-wrapper');
}

function onPointerDown(e: PointerEvent): void {
  // Primary button / primary pointer only (ignore right-click, middle-click).
  if (e.button !== 0) return;
  const wrapper = readerWrapperFrom(e.target);
  if (!wrapper) return;
  // Collapse the native selection auto-scroll's oversized top trigger band for the duration
  // of this drag.
  wrapper.style.scrollPaddingTop = '0px';
  overriddenEl = wrapper;
}

function restore(): void {
  if (overriddenEl) {
    overriddenEl.style.scrollPaddingTop = ''; // revert to the stylesheet value (192px)
    overriddenEl = null;
  }
}

export function initSelectionAutoScroll(): void {
  // ButtonRegistry re-runs init on every reader entry. The document-level listeners survive
  // SPA navigation, so attach them once and just clear any stale override on re-entry.
  restore();
  if (initialized) return;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', restore, true);
  document.addEventListener('pointercancel', restore, true);
  // Safety net: if a pointerup is lost (pointer left the window), don't leave padding zeroed.
  window.addEventListener('blur', restore);
  initialized = true;
}

export function destroySelectionAutoScroll(): void {
  // Keep the page-agnostic document listeners alive across SPA nav (inert outside the reader
  // wrapper); just clear any stale override so the next reader entry starts clean.
  restore();
}
