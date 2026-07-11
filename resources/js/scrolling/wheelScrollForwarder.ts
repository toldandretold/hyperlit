/**
 * wheelScrollForwarder — make the mouse wheel scroll the home / user / reader page from the
 * "dead zones" outside the centered content column.
 *
 * The only scrollable element on these pages is the content wrapper
 * (`.home-content-wrapper` / `.user-content-wrapper` / `.reader-content-wrapper`), which on
 * desktop is a narrow centered column (`max-width: var(--content-width, 40ch); margin: 0 auto`).
 * Two regions therefore have no scroll target under the pointer:
 *   1. The `position:fixed` `.fixed-header` (its containing block is the viewport, so a wheel
 *      over it targets the root scroller — `html`/`body`, which are `overflow:hidden`). It must
 *      stay fixed for the homepage hero's transform-docking animation, so this can't be a CSS fix.
 *      (Home / user only — the reader has no `.fixed-header`.)
 *   2. The viewport margins beside the column, which belong to `#app-container` (no overflow).
 *      On the reader these are the `.spacer`s flanking the centered `.reader-content-wrapper`.
 * Both work on touch because at ≤400px `--content-width` becomes `100%` and the wrapper fills
 * the viewport (theme/variables.css) — hence "scrolls on phone, not with the mouse".
 *
 * Fix: a single document capture-phase `wheel` listener. When the pointer is in a dead zone
 * (over `.fixed-header`, or NOT over the scrollable reading content), forward the delta to the
 * wrapper and preventDefault. Over the reading content itself (anywhere inside a wrapper —
 * `CONTENT_SEL` matches the whole `.reader-content-wrapper`) it does nothing, so native scroll
 * (momentum / overscroll) is preserved there. Forwarding `scrollTop` fires a `scroll` event, so
 * the homepage hero's own scroll handler still drives its docking/parallax/copy-fade.
 *
 * Listener-bearing component → registered via ButtonRegistry (components/utilities/
 * registerComponents.ts) for pages ['home','user','reader'], NOT a @vite side-effect or a top-level
 * global singleton. It listens on `document`, so one session instance survives SPA navigation;
 * init just no-ops if already created.
 */

let wheelHandler: ((e: WheelEvent) => void) | null = null;

const WRAPPER_SEL = '.home-content-wrapper, .user-content-wrapper, .reader-content-wrapper';
// scrollable reading content — native scroll already works here, leave it alone
const CONTENT_SEL =
  '.home-content-wrapper .main-content, .user-content-wrapper .main-content, .welcome-copy, .reader-content-wrapper';
// overlays that are their own scrollers but sit outside the content wrapper, so the
// dead-zone rule below would forward their wheel to the page — exempt them explicitly:
// the search-results dropdown (inside .fixed-header), the newbook/import form, the glass
// panels (TOC / user auth / source), each of which scrolls via its own inner .scroller,
// the citation-mode results panel (sibling of #edit-toolbar, scrolls its own result list
// via overflow-y:auto), and the shelf-preview overlay (appended to document.body). Without
// these the capture-phase handler steals the wheel from the panel and scrolls the page behind it.
const SCROLLABLE_OVERLAY_SEL =
  '#search-results-container, #newbook-container, #toc-container, #user-container, #source-container, #citation-toolbar-results, .shelf-preview-overlay';

export function initWheelScrollForwarder(): void {
  if (wheelHandler) return; // document-delegated singleton — create once
  wheelHandler = (e: WheelEvent) => {
    // this class deliberately locks wrapper scroll (containers.css) — don't fight it
    if (document.body.classList.contains('hyperlit-container-open')) return;
    const wrapper = document.querySelector<HTMLElement>(WRAPPER_SEL);
    if (!wrapper) return;
    const target = e.target instanceof Element ? e.target : null;
    // scrollable overlay inside the fixed header (search results) → let it scroll natively
    if (target && target.closest(SCROLLABLE_OVERLAY_SEL)) return;
    // over the reading content (and not the fixed card): let native scroll run
    if (target && target.closest(CONTENT_SEL) && !target.closest('.fixed-header')) return;
    // dead zone (fixed header or side margins) → forward the wheel to the scroller
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line-mode → ~px
    if (delta === 0) return; // ignore pure-horizontal wheels
    wrapper.scrollTop += delta;
    e.preventDefault();
  };
  document.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
}

export function destroyWheelScrollForwarder(): void {
  if (wheelHandler) document.removeEventListener('wheel', wheelHandler, true);
  wheelHandler = null;
}
