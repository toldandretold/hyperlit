/**
 * @vitest-environment jsdom
 *
 * buildImageNode — the <img>-is-the-node shape for fresh editor uploads, and
 * the pin for the E2EE zero-new-save-path claim: the encrypted preview shape
 * (blob src + data-hl-src canonical) must round-trip through the REAL save
 * processor with the canonical src restored and no transient markers left.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { content: vi.fn() },
}));

import { buildImageNode } from '../../../resources/js/divEditor/imageDrop/buildImageNode';
import { processNodeContentHighlightsAndCites } from '../../../resources/js/indexedDB/nodes/contentProcessor';

const upload = {
  filename: 'ab12cd34-photo.png',
  width: 640,
  height: 480,
  src: '/book_test/media/ab12cd34-photo.png',
  encrypted: false,
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildImageNode', () => {
  it('plaintext: canonical src + width/height attrs + aspect-ratio', () => {
    const img = buildImageNode(upload, { encrypted: false });

    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(upload.src);
    expect(img.getAttribute('width')).toBe('640');
    expect(img.getAttribute('height')).toBe('480');
    expect(img.style.aspectRatio).toBe('640 / 480');
    expect(img.hasAttribute('data-hl-src')).toBe(false);
  });

  it('omits size attrs when dims are unknown (SVG)', () => {
    const img = buildImageNode({ ...upload, width: null, height: null }, { encrypted: false });

    expect(img.hasAttribute('width')).toBe(false);
    expect(img.hasAttribute('height')).toBe(false);
  });

  it('encrypted: blob preview src + canonical in data-hl-src', () => {
    const img = buildImageNode({ ...upload, encrypted: true }, {
      encrypted: true,
      previewBlobUrl: 'blob:https://example.test/preview-1',
    });

    expect(img.getAttribute('data-hl-src')).toBe(upload.src);
    expect(img.getAttribute('src')).toBe('blob:https://example.test/preview-1');
  });

  it('encrypted shape round-trips through the save processor with the canonical src', () => {
    const img = buildImageNode({ ...upload, encrypted: true }, {
      encrypted: true,
      previewBlobUrl: 'blob:https://example.test/preview-2',
    });
    img.id = '150';
    img.setAttribute('data-node-id', 'book_test_1_abc');
    document.body.appendChild(img);

    const processed = processNodeContentHighlightsAndCites(img);

    expect(processed.content).toContain(`src="${upload.src}"`);
    expect(processed.content).not.toContain('blob:');
    expect(processed.content).not.toContain('data-hl-src');
  });
});
