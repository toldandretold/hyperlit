/**
 * figureViewer — the app's generic "expand a figure" overlay. Give it any
 * SVG or image and it opens a full-viewport viewer: pan by scrolling (both
 * axes), zoom via fixed bottom controls, download, Escape/✕ to close. First
 * customer: the yield report's knowledge-network tree (graphRenderer), but
 * ANY figure in the app can route through here.
 *
 * Near-leaf module: imports only the modalFocusTrap leaf (focus seats inside,
 * Tab cycles, Escape closes, focus returns to the trigger — the overlay gate's
 * contract; registered in overlaySurfacesInventory.json as trapModalFocus).
 * All styling is inline: the viewer floats over ANY page, so it must not
 * depend on which CSS bundles that page loaded.
 */

import { trapModalFocus } from './modalFocusTrap';

type Figure = SVGSVGElement | HTMLImageElement;

interface FigureViewerOptions {
  /** Heading shown top-left. */
  title?: string;
  /** Filename for the ⤓ download (default figure.svg / figure.png). */
  downloadName?: string;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;

/** One viewer at a time — opening a second closes the first. */
let activeClose: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  styles: Partial<CSSStyleDeclaration>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, styles);
  return node;
}

/** Shared look for the control-bar buttons. */
function controlButton(label: string, ariaLabel: string): HTMLButtonElement {
  const btn = el('button', {
    font: '1rem/1 sans-serif',
    padding: '0.45em 0.8em',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    borderRadius: '6px',
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'inherit',
    cursor: 'pointer',
  });
  btn.type = 'button';
  btn.textContent = label;
  btn.setAttribute('aria-label', ariaLabel);
  return btn;
}

/** The figure's natural CSS-pixel width — the zoom=1 baseline. */
function naturalWidth(figure: Figure): number {
  if (figure instanceof HTMLImageElement) {
    return figure.naturalWidth || figure.width || 800;
  }
  const viewBox = figure.viewBox?.baseVal;
  return viewBox?.width || figure.getBoundingClientRect().width || 800;
}

/** Serialize an SVG for standalone download (dark backdrop: the in-app figure
 * colours assume the reader's dark theme via var() fallbacks). */
function svgDownloadUrl(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.background = '#221f20';
  const markup = new XMLSerializer().serializeToString(clone);
  return URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
}

export function openFigureViewer(figure: Figure, options: FigureViewerOptions = {}): void {
  activeClose?.();

  const isSvg = !(figure instanceof HTMLImageElement);
  const shown = figure.cloneNode(true) as Figure;

  const overlay = el('div', {
    position: 'fixed',
    inset: '0',
    zIndex: '10000',
    background: 'var(--color-background, #221f20)',
    color: 'var(--color-text, #e0e0e0)',
  });
  overlay.id = 'figure-viewer-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', options.title ?? 'Expanded figure');

  // ── Scrollable pan area (both axes) ──
  const scroller = el('div', {
    position: 'absolute',
    inset: '0',
    overflow: 'auto',
    padding: '56px 24px 88px', // clears the title bar + control bar
    boxSizing: 'border-box',
  });

  // Explicit width drives zoom: unlike a CSS transform it grows the layout,
  // so the scroller's scrollbars track the zoomed size for real panning.
  const base = Math.min(naturalWidth(figure), window.innerWidth * 3);
  let zoom = 1;
  const fitWidth = (): number => Math.max(window.innerWidth - 48, 320);
  // Open at fit-to-viewport-width; zooming multiplies from there.
  let baseWidth = Math.min(base, fitWidth());
  if (baseWidth < fitWidth()) baseWidth = fitWidth();

  shown.style.width = `${baseWidth}px`;
  shown.style.maxWidth = 'none';
  shown.style.height = 'auto';
  shown.style.display = 'block';
  scroller.appendChild(shown);
  overlay.appendChild(scroller);

  // ── Title (top-left) + close (top-right) ──
  if (options.title) {
    const title = el('div', {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '64px',
      padding: '0.9em 1.2em',
      font: '600 1rem/1.2 sans-serif',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      pointerEvents: 'none',
    });
    title.textContent = options.title;
    overlay.appendChild(title);
  }

  const closeBtn = controlButton('✕', 'Close expanded figure');
  Object.assign(closeBtn.style, { position: 'absolute', top: '10px', right: '12px' });
  overlay.appendChild(closeBtn);

  // ── Bottom control bar: zoom out / level / zoom in / download ──
  const bar = el('div', {
    position: 'absolute',
    bottom: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    padding: '8px 12px',
    borderRadius: '10px',
    background: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(6px)',
  });

  const zoomOut = controlButton('−', 'Zoom out');
  const zoomLevel = el('span', {
    font: '0.85rem/1 sans-serif',
    minWidth: '4em',
    textAlign: 'center',
    opacity: '0.85',
  });
  const zoomIn = controlButton('+', 'Zoom in');
  const download = controlButton('⤓', 'Download figure');

  const applyZoom = (next: number): void => {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    shown.style.width = `${Math.round(baseWidth * zoom)}px`;
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  };
  applyZoom(1);
  zoomOut.addEventListener('click', () => applyZoom(zoom / ZOOM_STEP));
  zoomIn.addEventListener('click', () => applyZoom(zoom * ZOOM_STEP));

  let blobUrl: string | null = null;
  download.addEventListener('click', () => {
    const a = document.createElement('a');
    if (isSvg) {
      blobUrl ??= svgDownloadUrl(shown as SVGSVGElement);
      a.href = blobUrl;
      a.download = options.downloadName ?? 'figure.svg';
    } else {
      a.href = (figure as HTMLImageElement).src;
      a.download = options.downloadName ?? 'figure.png';
    }
    a.click();
  });

  bar.append(zoomOut, zoomLevel, zoomIn, download);
  overlay.appendChild(bar);

  document.body.appendChild(overlay);

  const release = trapModalFocus(overlay, { onEscape: () => close() });
  const close = (): void => {
    if (activeClose !== close) return; // already closed
    activeClose = null;
    release(); // restores focus to the trigger
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.remove();
  };
  activeClose = close;
  closeBtn.addEventListener('click', close);
}
