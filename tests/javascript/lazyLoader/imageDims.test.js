/**
 * imageDims — render-time width/height application from the per-book
 * book_images dimension map (the no-layout-shift root fix).
 *
 * Under test (resources/js/lazyLoader/imageDims.ts):
 *  - primeImageDims fetches /api/books/{book}/images ONCE per book (dedupe)
 *  - applyImageDims stamps width/height + style.aspectRatio onto attr-less
 *    media imgs, synchronously when the map is resolved, deferred while the
 *    fetch is in flight
 *  - existing attrs are never clobbered; non-media srcs and null-dim rows
 *    (SVG) are left alone; E2EE post-swap imgs resolve via data-hl-src
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeFetchMock(imagesByBook, { deferred = false } = {}) {
  const calls = [];
  let releases = [];
  const fetchImpl = vi.fn((url) => {
    calls.push(url);
    const book = decodeURIComponent(url.match(/\/api\/books\/([^/]+)\/images/)?.[1] ?? '');
    const body = { success: true, images: imagesByBook[book] ?? [] };
    const response = { ok: true, json: async () => body };
    if (!deferred) return Promise.resolve(response);
    return new Promise((resolve) => releases.push(() => resolve(response)));
  });
  return { fetchImpl, calls, release: () => { releases.forEach((r) => r()); releases = []; } };
}

async function loadModule() {
  vi.resetModules();
  return import('../../../resources/js/lazyLoader/imageDims');
}

function mediaImg(src, attrs = {}) {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  for (const [k, v] of Object.entries(attrs)) img.setAttribute(k, v);
  const wrap = document.createElement('div');
  wrap.appendChild(img);
  return { img, wrap };
}

const ROWS = {
  book_1: [
    { filename: 'fig1.png', width: 800, height: 600 },
    { filename: 'diagram.svg', width: null, height: null },
  ],
};

describe('imageDims dimension map application', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps width/height + aspect-ratio on an attr-less media img (resolved map)', async () => {
    const { fetchImpl } = makeFetchMock(ROWS);
    vi.stubGlobal('fetch', fetchImpl);
    const { primeImageDims, applyImageDims } = await loadModule();
    await primeImageDims('book_1');

    const { img, wrap } = mediaImg('/book_1/media/fig1.png');
    applyImageDims(wrap);
    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('600');
    expect(img.style.aspectRatio).toBe('800 / 600');
  });

  it('never clobbers existing width/height attrs', async () => {
    const { fetchImpl } = makeFetchMock(ROWS);
    vi.stubGlobal('fetch', fetchImpl);
    const { primeImageDims, applyImageDims } = await loadModule();
    await primeImageDims('book_1');

    const { img, wrap } = mediaImg('/book_1/media/fig1.png', { width: '50', height: '40' });
    applyImageDims(wrap);
    expect(img.getAttribute('width')).toBe('50');
    expect(img.getAttribute('height')).toBe('40');
  });

  it('fetches once per book (dedupe), including across apply-triggered primes', async () => {
    const { fetchImpl, calls } = makeFetchMock(ROWS);
    vi.stubGlobal('fetch', fetchImpl);
    const { primeImageDims, applyImageDims } = await loadModule();
    await Promise.all([primeImageDims('book_1'), primeImageDims('book_1')]);

    const { wrap } = mediaImg('/book_1/media/fig1.png');
    applyImageDims(wrap);
    await Promise.resolve();
    expect(calls.length).toBe(1);
  });

  it('applies late when the map resolves after render (belt stays as safety meanwhile)', async () => {
    const { fetchImpl, release } = makeFetchMock(ROWS, { deferred: true });
    vi.stubGlobal('fetch', fetchImpl);
    const { applyImageDims } = await loadModule();

    // No prime yet — apply self-primes and defers.
    const { img, wrap } = mediaImg('/book_1/media/fig1.png');
    applyImageDims(wrap);
    expect(img.getAttribute('width')).toBeNull();

    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('600');
  });

  it('keys the book from the img src itself (sub-book container referencing root media)', async () => {
    const { fetchImpl, calls } = makeFetchMock(ROWS);
    vi.stubGlobal('fetch', fetchImpl);
    const { applyImageDims } = await loadModule();

    // Rendering instance is a sub-book, but the src carries the root book.
    const { img, wrap } = mediaImg('/book_1/media/fig1.png');
    applyImageDims(wrap);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toContain('/api/books/book_1/images');
    expect(img.getAttribute('width')).toBe('800');
  });

  it('resolves the canonical src via data-hl-src for E2EE blob-swapped imgs', async () => {
    const { fetchImpl } = makeFetchMock(ROWS);
    vi.stubGlobal('fetch', fetchImpl);
    const { primeImageDims, applyImageDims } = await loadModule();
    await primeImageDims('book_1');

    const { img, wrap } = mediaImg('blob:https://x/abc');
    img.dataset.hlSrc = '/book_1/media/fig1.png';
    applyImageDims(wrap);
    expect(img.getAttribute('width')).toBe('800');
  });

  it('leaves non-media srcs and null-dim (SVG) rows alone', async () => {
    const { fetchImpl, calls } = makeFetchMock(ROWS);
    vi.stubGlobal('fetch', fetchImpl);
    const { primeImageDims, applyImageDims } = await loadModule();
    await primeImageDims('book_1');

    const external = mediaImg('https://example.com/pic.png');
    const svg = mediaImg('/book_1/media/diagram.svg');
    applyImageDims(external.wrap);
    applyImageDims(svg.wrap);
    expect(external.img.getAttribute('width')).toBeNull();
    expect(svg.img.getAttribute('width')).toBeNull();
    expect(calls.length).toBe(1); // the external src never triggered a prime
  });

  it('caches an empty map on fetch failure (no retry storm; belt covers)', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('down')));
    vi.stubGlobal('fetch', failing);
    const { primeImageDims, applyImageDims } = await loadModule();
    await primeImageDims('book_1');

    const { img, wrap } = mediaImg('/book_1/media/fig1.png');
    applyImageDims(wrap);
    expect(img.getAttribute('width')).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
