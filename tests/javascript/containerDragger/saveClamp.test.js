/**
 * Regression test for the container resize save-guard
 * (resources/js/components/containerDragger/containerDragger.ts, endDragOrResize).
 *
 * The original bug: if the container's right edge is measured while it sits PAST the viewport's
 * right edge (e.g. captured mid slide-in), the saved offset `window.innerWidth - rect.right`
 * goes negative and the panel is then re-opened off-screen. The guard floors the offset and
 * clamps the saved width so a bad measurement can never be persisted.
 *
 * happy-dom: getBoundingClientRect returns zeros, so the container rect is stubbed to reproduce
 * the off-screen-right condition. The customizer is stubbed so we can inspect what gets saved.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { initContainerDragger } from '../../../resources/js/components/containerDragger/containerDragger';

function setViewport(width) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

function stubRect(el, { left, right, top = 10, bottom = 400 }) {
  el.getBoundingClientRect = () => ({
    top, bottom, left, right, x: left, y: top, width: right - left, height: bottom - top,
    toJSON() {},
  });
}

function buildSourceContainer() {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = 'source-container';
  const edge = document.createElement('div');
  edge.className = 'resize-edge resize-left';
  container.appendChild(edge);
  document.body.appendChild(container);
  return { container, edge };
}

function fire(target, type, { clientX = 0, clientY = 0 } = {}) {
  target.dispatchEvent(new window.MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true }));
}

describe('containerDragger save-guard', () => {
  let updateContainer;

  beforeEach(() => {
    updateContainer = vi.fn();
    window.containerCustomizer = { updateContainer };
    initContainerDragger();
  });

  it('never saves a negative/off-screen right offset, and clamps width to the viewport', () => {
    setViewport(400);
    const { container, edge } = buildSourceContainer();
    // Right edge at 700 on a 400px viewport => off-screen right => raw offset would be -300.
    stubRect(container, { left: 100, right: 700 });

    fire(edge, 'mousedown', { clientX: 100, clientY: 100 });
    fire(document, 'mousemove', { clientX: 60, clientY: 100 });
    fire(document, 'mouseup');

    expect(updateContainer).toHaveBeenCalledTimes(1);
    const [id, custom] = updateContainer.mock.calls[0];
    expect(id).toBe('source-container');

    const savedRight = parseFloat(custom.right);
    const savedWidth = parseFloat(custom.width);
    // Offset floored on-screen (>= MIN_EDGE_GAP), never the raw -300.
    expect(savedRight).toBeGreaterThanOrEqual(8);
    // Width can't overflow: bounded by viewport minus a symmetric margin.
    expect(savedWidth).toBeLessThanOrEqual(400 - 2 * savedRight);
    expect(custom.left).toBe('auto');
  });
});
