/**
 * insertBlockNodeAfter / insertBlockNodeBefore — the generalized "insert a
 * prepared element as a NEW node" recipe (image drop / toolbar image insert).
 * Uses the REAL idHelpers so the fractional-id minting between neighbours is
 * exercised (default happy-dom env + the decimal-id selector shim), with the
 * save chokepoint mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';

installDecimalIdSelectorShim();

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/app.js', () => ({ book: 'book_test' }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: new Proxy({}, { get: () => vi.fn() }),
  verbose: new Proxy({}, { get: () => vi.fn() }),
  isVerboseEnabled: () => false,
}));
vi.mock('../../../resources/js/utilities/IDfunctions', () => ({
  triggerRenumberingWithModal: vi.fn().mockResolvedValue(undefined),
}));

import { insertBlockNodeAfter, insertBlockNodeBefore } from '../../../resources/js/divEditor/insertBlockNode';

const BOOK = 'book_test';

function buildChunk(ids) {
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', '0');
  for (const id of ids) {
    const p = document.createElement('p');
    p.id = id;
    p.setAttribute('data-node-id', `${BOOK}_seed_${id}`);
    p.textContent = `node ${id}`;
    chunk.appendChild(p);
  }
  document.body.appendChild(chunk);
  return chunk;
}

function freshImg() {
  const img = document.createElement('img');
  img.setAttribute('src', '/book_test/media/x.png');
  return img;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('insertBlockNodeAfter', () => {
  it('mints an id strictly between adjacent neighbours and inserts into the chunk', () => {
    const chunk = buildChunk(['100', '200']);
    const img = freshImg();

    const inserted = insertBlockNodeAfter(document.getElementById('100'), img, BOOK);

    expect(inserted).toBe(img);
    expect(img.parentElement).toBe(chunk);
    expect(img.previousElementSibling.id).toBe('100');
    expect(img.nextElementSibling.id).toBe('200');
    const minted = parseFloat(img.id);
    expect(minted).toBeGreaterThan(100);
    expect(minted).toBeLessThan(200);
    expect(img.getAttribute('data-node-id')).toBeTruthy();
    expect(queueNodeForSave).toHaveBeenCalledWith(img.id, 'add', BOOK);
  });

  it('appends at the end when the anchor is the last node', () => {
    const chunk = buildChunk(['100']);
    const img = freshImg();

    insertBlockNodeAfter(document.getElementById('100'), img, BOOK);

    expect(chunk.lastElementChild).toBe(img);
    expect(parseFloat(img.id)).toBeGreaterThan(100);
    expect(queueNodeForSave).toHaveBeenCalledWith(img.id, 'add', BOOK);
  });

  it('skips non-numeric-id siblings when finding the next bound', () => {
    const chunk = buildChunk(['100']);
    const decoration = document.createElement('div');
    decoration.className = 'some-render-artifact';
    chunk.appendChild(decoration);
    const tail = document.createElement('p');
    tail.id = '101';
    chunk.appendChild(tail);
    const img = freshImg();

    insertBlockNodeAfter(document.getElementById('100'), img, BOOK);

    const minted = parseFloat(img.id);
    expect(minted).toBeGreaterThan(100);
    expect(minted).toBeLessThan(101);
  });

  it('assigns the anchor an id first when it lacks one (ensureNodeHasValidId)', () => {
    const chunk = buildChunk(['100', '200']);
    const orphan = document.createElement('p');
    orphan.textContent = 'no id yet';
    chunk.insertBefore(orphan, chunk.lastElementChild);
    const img = freshImg();

    const inserted = insertBlockNodeAfter(orphan, img, BOOK);

    expect(orphan.id).toMatch(/^\d+(\.\d+)?$/);
    expect(inserted).toBe(img);
    expect(img.id).toMatch(/^\d+(\.\d+)?$/);
  });
});

describe('insertBlockNodeBefore', () => {
  it('mints an id strictly between the previous neighbour and the anchor', () => {
    const chunk = buildChunk(['100', '200']);
    const img = freshImg();

    const inserted = insertBlockNodeBefore(document.getElementById('200'), img, BOOK);

    expect(inserted).toBe(img);
    expect(img.parentElement).toBe(chunk);
    expect(img.nextElementSibling.id).toBe('200');
    const minted = parseFloat(img.id);
    expect(minted).toBeGreaterThan(100);
    expect(minted).toBeLessThan(200);
    expect(queueNodeForSave).toHaveBeenCalledWith(img.id, 'add', BOOK);
  });

  it('handles inserting before the first node (no previous bound)', () => {
    const chunk = buildChunk(['100']);
    const img = freshImg();

    insertBlockNodeBefore(document.getElementById('100'), img, BOOK);

    expect(chunk.firstElementChild).toBe(img);
    expect(img.id).toMatch(/^\d+(\.\d+)?$/);
    expect(parseFloat(img.id)).toBeLessThan(100);
  });
});
