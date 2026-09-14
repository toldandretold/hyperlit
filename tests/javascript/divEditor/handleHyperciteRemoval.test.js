/**
 * First un-mocked coverage of handleHyperciteRemoval — the 4-CHECK hypercite
 * deletion engine in resources/js/divEditor/domUtilities.ts. Every other test
 * that touches it injects a vi.fn(), so the move-vs-delete verifyRemoval guard
 * (immediate + 50ms delayed re-check) and the tombstone contract were untested.
 *
 * Uses the built-in `window.testDelinkHypercite` seam (domUtilities.ts) to
 * observe delink calls; IDB + ghost-marking are mocked at the module boundary.
 * Real timers — the 50ms verify window is part of the behavior under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/divEditor/chunkManager', () => ({ trackChunkNodeCount: vi.fn() }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/paste/pasteState', () => ({ isPasteOperationActive: () => false }));
vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: vi.fn(async () => ({})) }));
vi.mock('../../../resources/js/hypercites/database.js', () => ({ getHyperciteById: vi.fn() }));
vi.mock('../../../resources/js/hypercites/deletion', () => ({ markHyperciteAsGhost: vi.fn(async () => true) }));

import { handleHyperciteRemoval } from '../../../resources/js/divEditor/domUtilities';
import { getHyperciteById } from '../../../resources/js/hypercites/database.js';
import { markHyperciteAsGhost } from '../../../resources/js/hypercites/deletion';
import { queueNodeForSave } from '../../../resources/js/divEditor/editorState';

let delinkSpy;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delinkSpy = vi.fn(async () => {});
  window.testDelinkHypercite = delinkSpy;
});

afterEach(() => {
  delete window.testDelinkHypercite;
});

function detachedAnchor(id, href) {
  const a = document.createElement('a');
  a.id = id;
  a.href = href;
  a.textContent = '↗';
  return a;
}

describe('CHECK 1 — removed citation anchor', () => {
  it('delinks a truly-removed <a href="#hypercite_…">', async () => {
    const a = detachedAnchor('hypercite_c1', '/bookb#hypercite_src1');

    await handleHyperciteRemoval(a, document.body);

    expect(delinkSpy).toHaveBeenCalledTimes(1);
    expect(delinkSpy).toHaveBeenCalledWith('hypercite_c1', a.href);
  });

  it('skips delink when an element with the same id is still in the DOM (move, not delete)', async () => {
    document.body.innerHTML = '<p><a id="hypercite_c1" href="/bookb#hypercite_src1">↗</a></p>';
    const removedCopy = detachedAnchor('hypercite_c1', '/bookb#hypercite_src1');

    await handleHyperciteRemoval(removedCopy, document.body);

    expect(delinkSpy).not.toHaveBeenCalled();
  });

  it('skips delink when the same id is RE-INSERTED within the 50ms verify window (cut→immediate paste-back)', async () => {
    const a = detachedAnchor('hypercite_c1', '/bookb#hypercite_src1');

    const pending = handleHyperciteRemoval(a, document.body);
    setTimeout(() => {
      document.body.appendChild(detachedAnchor('hypercite_c1', '/bookb#hypercite_src1'));
    }, 10);
    await pending;

    expect(delinkSpy).not.toHaveBeenCalled();
  });
});

describe('CHECK 2 — removed source <u> wrapper', () => {
  it('creates a tombstone in the mutation-target block and marks the record ghost when citedIN is non-empty', async () => {
    document.body.innerHTML = '<div class="chunk"><p id="100">surviving text</p></div>';
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_src1', citedIN: ['/bookb#hypercite_c1'] });
    const u = document.createElement('u');
    u.id = 'hypercite_src1';
    u.className = 'couple';
    u.textContent = 'cited text';

    await handleHyperciteRemoval(u, document.getElementById('100'));

    const tombstone = document.getElementById('hypercite_src1');
    expect(tombstone).not.toBeNull();
    expect(tombstone.tagName).toBe('U');
    expect(tombstone.classList.contains('hypercite-tombstone')).toBe(true);
    expect(tombstone.getAttribute('data-ghost')).toBe('true');
    expect(tombstone.parentElement.id).toBe('100');
    expect(markHyperciteAsGhost).toHaveBeenCalledWith('hypercite_src1');
  });

  it('does NOTHING for an uncited <u> ("clean deletion" — record intentionally left to the save-time reconciler)', async () => {
    document.body.innerHTML = '<div class="chunk"><p id="100">surviving</p></div>';
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_src1', citedIN: [] });
    const u = document.createElement('u');
    u.id = 'hypercite_src1';
    u.textContent = 'cited text';

    await handleHyperciteRemoval(u, document.getElementById('100'));

    expect(document.getElementById('hypercite_src1')).toBeNull();
    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
  });

  it('does nothing when the record is missing from IndexedDB', async () => {
    document.body.innerHTML = '<div class="chunk"><p id="100">surviving</p></div>';
    getHyperciteById.mockResolvedValue(undefined);
    const u = document.createElement('u');
    u.id = 'hypercite_src1';
    u.textContent = 'cited text';

    await handleHyperciteRemoval(u, document.getElementById('100'));

    expect(document.getElementById('hypercite_src1')).toBeNull();
    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
  });
});

describe('CHECK 3 — anchors nested inside a removed container', () => {
  it('delinks every hypercite anchor found inside the removed element', async () => {
    const p = document.createElement('p');
    p.innerHTML = '<a id="hypercite_c1" href="/bookb#hypercite_s1">↗</a> and '
      + '<a id="hypercite_c2" href="/bookc#hypercite_s2">↗</a>';

    await handleHyperciteRemoval(p, document.body);

    expect(delinkSpy).toHaveBeenCalledTimes(2);
    expect(delinkSpy).toHaveBeenCalledWith('hypercite_c1', expect.stringContaining('#hypercite_s1'));
    expect(delinkSpy).toHaveBeenCalledWith('hypercite_c2', expect.stringContaining('#hypercite_s2'));
  });
});

describe('CHECK 4 — tombstones inside a removed container', () => {
  it('relocates the tombstone into the surviving mutation-target block and queues it for save', async () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk"><p id="100">alive</p></div></div>';
    const removedP = document.createElement('p');
    removedP.id = '101';
    removedP.innerHTML = 'gone <u id="hypercite_gh1" class="hypercite-tombstone" data-ghost="true"></u>';

    await handleHyperciteRemoval(removedP, document.getElementById('100'));

    const relocated = document.getElementById('hypercite_gh1');
    expect(relocated).not.toBeNull();
    expect(relocated.parentElement.id).toBe('100');
    expect(relocated.classList.contains('hypercite-tombstone')).toBe(true);
    expect(queueNodeForSave).toHaveBeenCalledWith('100', 'update');
  });

  it('does not duplicate a tombstone that already exists in the live DOM', async () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk">'
      + '<p id="100">alive <u id="hypercite_gh1" class="hypercite-tombstone" data-ghost="true"></u></p></div></div>';
    const removedP = document.createElement('p');
    removedP.id = '101';
    removedP.innerHTML = '<u id="hypercite_gh1" class="hypercite-tombstone" data-ghost="true"></u>';

    await handleHyperciteRemoval(removedP, document.getElementById('100'));

    expect(document.querySelectorAll('#hypercite_gh1, u.hypercite-tombstone')).toHaveLength(1);
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });
});
