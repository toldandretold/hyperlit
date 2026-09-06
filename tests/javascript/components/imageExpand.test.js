/**
 * imageExpand — the shared ⤢ button on reader content images. Pins: shows on
 * pointerover of a qualifying content img (positioned at its top-right);
 * suppressed inside contenteditable (edit mode), for broken images and
 * video-embed posters; button click opens the figureViewer with the
 * downloadName derived from data-hl-src (canonical) over src; destroy removes
 * the button and listeners. Plus the contentProcessor belt: a stray button in
 * content never persists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { openFigureViewer } = vi.hoisted(() => ({ openFigureViewer: vi.fn() }));
vi.mock('../../../resources/js/utilities/figureViewer', () => ({ openFigureViewer }));

import { initializeImageExpand, destroyImageExpand } from '../../../resources/js/components/imageExpand/imageExpand';
import { processNodeContentHighlightsAndCites } from '../../../resources/js/indexedDB/nodes/contentProcessor';

function buildImg({ editable = false, classes = [], wrap = null, hlSrc = null } = {}) {
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  const holder = document.createElement(editable ? 'div' : 'p');
  if (editable) holder.setAttribute('contenteditable', 'true');
  const img = document.createElement('img');
  img.setAttribute('src', '/book_x/media/pic.png');
  classes.forEach((c) => img.classList.add(c));
  if (hlSrc) img.setAttribute('data-hl-src', hlSrc);
  img.getBoundingClientRect = () => ({ top: 50, bottom: 250, left: 20, right: 420, width: 400, height: 200, x: 20, y: 50 });

  let inner = img;
  if (wrap) {
    const wrapper = document.createElement('div');
    wrapper.className = wrap;
    wrapper.appendChild(img);
    inner = wrapper;
  }
  holder.appendChild(inner);
  chunk.appendChild(holder);
  document.body.appendChild(chunk);
  return img;
}

function hoverOn(el) {
  el.dispatchEvent(new Event('pointerover', { bubbles: true }));
}

const getButton = () => document.querySelector('.image-expand-btn');

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  initializeImageExpand();
});

afterEach(() => {
  destroyImageExpand();
});

describe('imageExpand', () => {
  it('shows the shared button at the hovered content image top-right', () => {
    const img = buildImg();
    hoverOn(img);

    const btn = getButton();
    expect(btn).not.toBeNull();
    expect(btn.style.display).toBe('block');
    expect(btn.style.top).toBe('58px'); // rect.top + 8
    expect(btn.style.left).toBe('380px'); // rect.right - 40
  });

  it('is suppressed inside a live contenteditable (edit mode)', () => {
    const img = buildImg({ editable: true });
    hoverOn(img);
    expect(getButton()?.style.display ?? 'none').toBe('none');
  });

  it('is suppressed for broken images and video embeds', () => {
    const broken = buildImg({ classes: ['broken-image'] });
    hoverOn(broken);
    expect(getButton()?.style.display ?? 'none').toBe('none');

    const wrapped = buildImg({ wrap: 'video-embed' });
    hoverOn(wrapped);
    expect(getButton()?.style.display ?? 'none').toBe('none');
  });

  it('ignores images outside a .chunk (UI chrome images)', () => {
    const img = document.createElement('img');
    img.setAttribute('src', '/logo.png');
    document.body.appendChild(img);
    hoverOn(img);
    expect(getButton()?.style.display ?? 'none').toBe('none');
  });

  it('button click opens the figureViewer with the canonical downloadName', () => {
    const img = buildImg({ hlSrc: '/book_x/media/secret-diagram.png' });
    img.src = 'blob:https://example.test/decrypted';
    hoverOn(img);

    getButton().dispatchEvent(new Event('click', { bubbles: true }));

    expect(openFigureViewer).toHaveBeenCalledTimes(1);
    const [figure, opts] = openFigureViewer.mock.calls[0];
    expect(figure).toBe(img);
    expect(opts.downloadName).toBe('secret-diagram.png');
  });

  it('falls back to the src basename when no data-hl-src', () => {
    const img = buildImg();
    hoverOn(img);
    getButton().dispatchEvent(new Event('click', { bubbles: true }));
    expect(openFigureViewer.mock.calls[0][1].downloadName).toBe('pic.png');
  });

  it('destroy removes the button and stops responding', () => {
    const img = buildImg();
    hoverOn(img);
    expect(getButton()).not.toBeNull();

    destroyImageExpand();
    expect(getButton()).toBeNull();

    hoverOn(img);
    expect(getButton()).toBeNull();
  });
});

describe('contentProcessor belt', () => {
  it('a stray .image-expand-btn inside content never persists', () => {
    const node = document.createElement('p');
    node.id = '100';
    node.setAttribute('data-node-id', 'book_x_1_abc');
    node.innerHTML = '<img src="/book_x/media/pic.png"><button class="image-expand-btn">⤢</button>';
    document.body.appendChild(node);

    const processed = processNodeContentHighlightsAndCites(node);

    expect(processed.content).not.toContain('image-expand-btn');
    expect(processed.content).toContain('/book_x/media/pic.png');
  });
});
