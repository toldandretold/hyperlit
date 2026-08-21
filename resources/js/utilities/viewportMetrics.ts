/**
 * Viewport metrics for the fixed right-hand panels — `#hyperlit-container`, its
 * `.hyperlit-container-stacked` layers, and `#source-container`.
 *
 * Those panels are `position: fixed; top: 1em`, so they anchor to the LAYOUT
 * viewport: the lowest y they can reach and still be on screen is the bottom of
 * the VISUAL viewport expressed in layout coordinates (`offsetTop + height`).
 *
 * `window.innerHeight` is NOT that number on mobile — it reports the large
 * viewport (browser chrome collapsed), so a panel sized from it runs under the
 * URL/tab bar. `visualViewport` is the only source that tracks the on-screen
 * area through keyboard, pinch-zoom and chrome collapse, so it is the basis
 * here and `innerHeight` is only the no-API fallback.
 *
 * Zero imports on purpose: this is pulled in by both `hyperlitContainer/*` and
 * `components/utilities/keyboardManager`, and a shared leaf cannot introduce a
 * circular-import TDZ.
 */

/** Top inset of the panels — matches their CSS `top: 1em` at the 16px root size. */
export const PANEL_TOP_MARGIN = 16;

/** Bottom gap assumed when the edit toolbar is absent. */
const DEFAULT_BOTTOM_GAP = 4;

function currentViewport(): VisualViewport | null {
  return window.visualViewport ?? null;
}

/**
 * Bottom edge of the on-screen area in layout-viewport coordinates — the lowest
 * y a `position: fixed` element can extend to and still be visible.
 */
export function getVisibleBottom(vv: VisualViewport | null = currentViewport()): number {
  if (!vv) return window.innerHeight;
  return vv.offsetTop + vv.height;
}

/**
 * Height a fixed right-hand panel may occupy: from its `top: 1em` down to the
 * bottom of the visible area, less room for whichever toolbar is parked there.
 */
export function getPanelMaxHeight(vv: VisualViewport | null = currentViewport()): number {
  const editToolbar = document.getElementById('edit-toolbar');
  const bottomGap = editToolbar ? editToolbar.offsetHeight : DEFAULT_BOTTOM_GAP;
  return getVisibleBottom(vv) - PANEL_TOP_MARGIN - bottomGap;
}

/**
 * Re-measure every currently open panel against `vv`. Called both when the
 * keyboard state flips and whenever a resize SETTLES — the keyboard-close path
 * necessarily measures mid-animation, so a settled pass is what corrects it.
 */
export function resizeOpenPanels(vv: VisualViewport | null = currentViewport()): void {
  const maxHeight = `${getPanelMaxHeight(vv)}px`;

  const base = document.getElementById('hyperlit-container');
  if (base && base.classList.contains('open')) {
    base.style.maxHeight = maxHeight;
  }

  document.querySelectorAll<HTMLElement>('.hyperlit-container-stacked').forEach((layer) => {
    layer.style.maxHeight = maxHeight;
  });
}
