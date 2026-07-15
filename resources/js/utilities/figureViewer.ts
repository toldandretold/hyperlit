/**
 * figureViewer — the app's generic "expand a figure" overlay. Give it any
 * SVG or image and it opens a full-viewport viewer: pan by scrolling OR
 * grab-and-drag, zoom and rotate via fixed bottom controls, download (SVG
 * as-is, or rasterized to JPG), Escape/✕ to close. First customer: the yield
 * report's knowledge-network tree (graphRenderer), but ANY figure in the app
 * can route through here.
 *
 * Near-leaf module: imports only the modalFocusTrap leaf (focus seats inside,
 * Tab cycles, Escape closes, focus returns to the trigger — the overlay gate's
 * contract; registered in overlaySurfacesInventory.json as trapModalFocus).
 * All styling is inline: the viewer floats over ANY page, so it must not
 * depend on which CSS bundles that page loaded.
 *
 * Zoom/rotate are LAYOUT-true: zoom sets a real pixel width and rotation
 * swaps the stage's width/height (not a bare CSS transform), so the
 * scroller's scrollbars always track the figure's visual footprint and
 * panning stays honest.
 */

import { trapModalFocus } from './modalFocusTrap';
import { log } from './logger';

type Figure = SVGSVGElement | HTMLImageElement;

interface FigureViewerOptions {
  /** Heading shown top-left. */
  title?: string;
  /** Base filename for downloads, extension replaced per format
   *  (default figure.svg / figure.png / figure.jpg). */
  downloadName?: string;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const DARK_BG = '#221f20'; // in-app figure colours assume the reader's dark theme
const JPEG_SCALE = 2; // raster export supersampling (crisper text)

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

/** The figure's natural CSS-pixel size — the zoom=1 / rotation-math baseline. */
function naturalSize(figure: Figure): { w: number; h: number } {
  if (figure instanceof HTMLImageElement) {
    const w = figure.naturalWidth || figure.width || 800;
    const h = figure.naturalHeight || figure.height || Math.round(w * 0.75);
    return { w, h };
  }
  const viewBox = figure.viewBox?.baseVal;
  if (viewBox?.width && viewBox?.height) return { w: viewBox.width, h: viewBox.height };
  const rect = figure.getBoundingClientRect();
  return { w: rect.width || 800, h: rect.height || 600 };
}

/** Serialize an SVG for standalone download (dark backdrop baked in). */
function svgDownloadUrl(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.background = DARK_BG;
  const markup = new XMLSerializer().serializeToString(clone);
  return URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

/** Rasterize the SVG through a canvas and download as JPEG (no alpha, so the
 * dark background is painted first). Async by nature — best-effort. */
function downloadSvgAsJpeg(svg: SVGSVGElement, name: string): void {
  const { w, h } = naturalSize(svg);
  const url = svgDownloadUrl(svg);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * JPEG_SCALE);
    canvas.height = Math.round(h * JPEG_SCALE);
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // canvas unavailable (ancient browser / test env)
    ctx.fillStyle = DARK_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const jpegUrl = URL.createObjectURL(blob);
      triggerDownload(jpegUrl, name);
      URL.revokeObjectURL(jpegUrl);
    }, 'image/jpeg', 0.92);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    log.error('figureViewer: SVG rasterization failed — JPG download aborted', 'figureViewer');
  };
  img.src = url;
}

export function openFigureViewer(figure: Figure, options: FigureViewerOptions = {}): void {
  activeClose?.();

  const isSvg = !(figure instanceof HTMLImageElement);
  const shown = figure.cloneNode(true) as Figure;
  const natural = naturalSize(figure);
  const aspect = natural.h / natural.w || 0.75;
  const baseName = (options.downloadName ?? 'figure.svg').replace(/\.[a-z]+$/i, '');

  const overlay = el('div', {
    position: 'fixed',
    inset: '0',
    zIndex: '10000',
    background: `var(--color-background, ${DARK_BG})`,
    color: 'var(--color-text, #e0e0e0)',
  });
  overlay.id = 'figure-viewer-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', options.title ?? 'Expanded figure');

  // ── Scrollable pan area (both axes; also grab-and-drag, below) ──
  const scroller = el('div', {
    position: 'absolute',
    inset: '0',
    overflow: 'auto',
    padding: '56px 24px 88px', // clears the title bar + control bar
    boxSizing: 'border-box',
    cursor: 'grab',
  });

  // The stage owns the figure's visual footprint: zoom sets a real pixel
  // width, rotation swaps the stage's width/height. Real layout keeps the
  // scrollbars honest (a bare CSS transform wouldn't grow the scroll area).
  const stage = el('div', { position: 'relative', margin: '0 auto' });
  shown.style.maxWidth = 'none';
  shown.style.display = 'block';
  stage.appendChild(shown);
  scroller.appendChild(stage);
  overlay.appendChild(scroller);

  const fitWidth = (): number => Math.max(window.innerWidth - 48, 320);
  // Open at fit-to-viewport-width; zooming multiplies from there.
  const baseWidth = Math.min(Math.max(natural.w, fitWidth()), window.innerWidth * 3);
  let zoom = 1;
  let rotation = 0; // 0 | 90 | 180 | 270

  const zoomLevel = el('span', {
    font: '0.85rem/1 sans-serif',
    minWidth: '4em',
    textAlign: 'center',
    opacity: '0.85',
  });

  const applyLayout = (): void => {
    const w = Math.round(baseWidth * zoom);
    const h = Math.round(w * aspect);
    shown.style.width = `${w}px`;
    shown.style.height = 'auto';
    if (rotation === 0) {
      // Unrotated: plain flow — no transform in play.
      shown.style.position = 'static';
      shown.style.top = '';
      shown.style.left = '';
      shown.style.transform = '';
      stage.style.width = `${w}px`;
      stage.style.height = 'auto';
    } else {
      // Rotated: the stage takes the ROTATED bounding box; the figure is
      // centered in it and spun around that center.
      const sideways = rotation % 180 !== 0;
      stage.style.width = `${sideways ? h : w}px`;
      stage.style.height = `${sideways ? w : h}px`;
      shown.style.position = 'absolute';
      shown.style.top = '50%';
      shown.style.left = '50%';
      shown.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  };

  // ── Grab-and-drag panning (mouse; touch already scrolls natively) ──
  let dragging = false;
  let dragStart = { x: 0, y: 0, left: 0, top: 0 };
  scroller.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.style.cursor = 'grabbing';
    try { scroller.setPointerCapture(e.pointerId); } catch { /* jsdom / older engines */ }
  });
  scroller.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    e.preventDefault(); // no text selection mid-drag
    scroller.scrollLeft = dragStart.left - (e.clientX - dragStart.x);
    scroller.scrollTop = dragStart.top - (e.clientY - dragStart.y);
  });
  const endDrag = (): void => {
    dragging = false;
    scroller.style.cursor = 'grab';
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);

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

  // ── Bottom control bar: zoom − / level / zoom + / rotate / downloads ──
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
  const zoomIn = controlButton('+', 'Zoom in');
  const rotate = controlButton('↻', 'Rotate 90 degrees');
  zoomOut.addEventListener('click', () => {
    zoom = Math.max(ZOOM_MIN, zoom / ZOOM_STEP);
    applyLayout();
  });
  zoomIn.addEventListener('click', () => {
    zoom = Math.min(ZOOM_MAX, zoom * ZOOM_STEP);
    applyLayout();
  });
  rotate.addEventListener('click', () => {
    rotation = (rotation + 90) % 360;
    applyLayout();
  });
  bar.append(zoomOut, zoomLevel, zoomIn, rotate);

  let svgBlobUrl: string | null = null;
  if (isSvg) {
    const dlSvg = controlButton('⤓ SVG', 'Download as SVG');
    dlSvg.addEventListener('click', () => {
      svgBlobUrl ??= svgDownloadUrl(shown as SVGSVGElement);
      triggerDownload(svgBlobUrl, `${baseName}.svg`);
    });
    const dlJpg = controlButton('⤓ JPG', 'Download as JPG');
    dlJpg.addEventListener('click', () => {
      downloadSvgAsJpeg(shown as SVGSVGElement, `${baseName}.jpg`);
    });
    bar.append(dlSvg, dlJpg);
  } else {
    const dl = controlButton('⤓', 'Download figure');
    dl.addEventListener('click', () => {
      triggerDownload((figure as HTMLImageElement).src, options.downloadName ?? 'figure.png');
    });
    bar.append(dl);
  }

  overlay.appendChild(bar);
  applyLayout();
  document.body.appendChild(overlay);

  const release = trapModalFocus(overlay, { onEscape: () => close() });
  const close = (): void => {
    if (activeClose !== close) return; // already closed
    activeClose = null;
    release(); // restores focus to the trigger
    if (svgBlobUrl) URL.revokeObjectURL(svgBlobUrl);
    overlay.remove();
  };
  activeClose = close;
  closeBtn.addEventListener('click', close);
}
