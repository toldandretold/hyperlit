/**
 * figureViewer — the generic expand-any-figure overlay (utilities/figureViewer.ts).
 * Locks the viewer contract: full-viewport dialog with the figure cloned in,
 * zoom via explicit width (real scroll dimensions, not a transform), download
 * as a standalone blob, and the overlay-gate keyboard model (focus seats
 * inside, Escape closes, focus returns to the trigger).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openFigureViewer } from '../../../resources/js/utilities/figureViewer';

function makeSvg(width = 934, height = 2500) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return svg;
}

function overlay() {
  return document.getElementById('figure-viewer-overlay');
}

beforeEach(() => {
  // jsdom lacks these; the viewer's download path needs them.
  URL.createObjectURL = vi.fn(() => 'blob:figure-test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  overlay()?.remove();
  document.body.innerHTML = '';
});

describe('openFigureViewer', () => {
  it('opens a full-viewport dialog containing a CLONE of the figure', () => {
    const container = document.createElement('div');
    const svg = makeSvg();
    container.appendChild(svg);
    document.body.appendChild(container);

    openFigureViewer(svg, { title: 'Knowledge network — Root' });

    const view = overlay();
    expect(view).not.toBeNull();
    expect(view.getAttribute('role')).toBe('dialog');
    expect(view.getAttribute('aria-modal')).toBe('true');
    expect(view.textContent).toContain('Knowledge network — Root');
    // A clone is shown — the original figure stays in the page.
    expect(view.querySelector('svg')).not.toBe(svg);
    expect(container.contains(svg)).toBe(true);
  });

  it('zoom buttons scale the figure via explicit width (layout, not transform)', () => {
    openFigureViewer(makeSvg());
    const view = overlay();
    const shown = view.querySelector('svg');
    const before = parseFloat(shown.style.width);
    expect(before).toBeGreaterThan(0);

    const zoomIn = view.querySelector('button[aria-label="Zoom in"]');
    zoomIn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(parseFloat(shown.style.width)).toBeCloseTo(before * 1.25, 0);
    expect(view.textContent).toContain('125%');

    const zoomOut = view.querySelector('button[aria-label="Zoom out"]');
    zoomOut.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    zoomOut.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(parseFloat(shown.style.width)).toBeCloseTo(before / 1.25, 0);
    expect(shown.style.transform).toBe(''); // width-based zoom, never transform
  });

  it('download serializes the SVG to a blob and revokes it on close', () => {
    openFigureViewer(makeSvg(), { downloadName: 'knowledge-network-book_x.svg' });
    const view = overlay();

    view.querySelector('button[aria-label="Download figure"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    view.querySelector('button[aria-label="Close expanded figure"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:figure-test');
  });

  it('the ✕ button closes; focus returns to the trigger (overlay-gate contract)', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Expand';
    document.body.appendChild(trigger);
    trigger.focus();

    openFigureViewer(makeSvg());
    const view = overlay();
    // Focus seated inside the dialog.
    expect(view.contains(document.activeElement)).toBe(true);

    view.querySelector('button[aria-label="Close expanded figure"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes the viewer', () => {
    openFigureViewer(makeSvg());
    expect(overlay()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay()).toBeNull();
  });

  it('opening a second figure closes the first (one viewer at a time)', () => {
    openFigureViewer(makeSvg(), { title: 'First' });
    openFigureViewer(makeSvg(), { title: 'Second' });
    const views = document.querySelectorAll('#figure-viewer-overlay');
    expect(views.length).toBe(1);
    expect(views[0].textContent).toContain('Second');
  });

  it('works for plain images too (downloads the src)', () => {
    const img = document.createElement('img');
    img.src = 'https://hyperlit.test/storage/figure.png';
    openFigureViewer(img, { downloadName: 'figure.png' });

    const view = overlay();
    expect(view.querySelector('img')).not.toBeNull();
    view.querySelector('button[aria-label="Download figure"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Image path: direct src download, no blob involved.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
