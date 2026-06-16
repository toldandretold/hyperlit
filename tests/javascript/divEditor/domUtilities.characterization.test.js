/**
 * Characterization of the cleanly-testable helpers in
 * resources/js/divEditor/domUtilities.js — the no-delete-id marker system,
 * numeric-node collection, and styled-span cleanup. Pinned before .js → .ts.
 *
 * (handleHyperciteRemoval / ensureMinimumDocumentStructure are big DOM-orchestration
 * functions with dynamic imports — exercised by the e2e grand tour.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/app.js', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/paste', () => ({ isPasteOperationActive: () => false }));
vi.mock('../../../resources/js/chunkManager.js', () => ({ trackChunkNodeCount: vi.fn() }));
vi.mock('../../../resources/js/utilities/IDfunctions', () => ({
  isNumericalId: (id) => /^\d+(\.\d+)?$/.test(id),
  setElementIds: vi.fn(),
}));

import {
  findAllNumericalIdNodesInChunks,
  getNoDeleteNode, setNoDeleteMarker, transferNoDeleteMarker, findNextNoDeleteNode,
  cleanupStyledSpans,
} from '../../../resources/js/divEditor/domUtilities.js';

beforeEach(() => { document.body.innerHTML = ''; vi.spyOn(console, 'log').mockImplementation(() => {}); });

describe('findAllNumericalIdNodesInChunks', () => {
  it('returns only numeric-id elements', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p id="1">a</p><p id="2.1">b</p><p id="abc">c</p><div id="x-sentinel"></div>';
    document.body.appendChild(host);
    expect(findAllNumericalIdNodesInChunks(host).map(n => n.id)).toEqual(['1', '2.1']);
  });
});

describe('no-delete-id marker system', () => {
  it('set/get moves the marker so only one node holds it', () => {
    const a = document.createElement('p'); a.id = '1';
    const b = document.createElement('p'); b.id = '2';
    document.body.append(a, b);

    setNoDeleteMarker(a);
    expect(getNoDeleteNode()).toBe(a);
    expect(a.getAttribute('no-delete-id')).toBe('please');

    setNoDeleteMarker(b);                 // moves the marker
    expect(getNoDeleteNode()).toBe(b);
    expect(a.hasAttribute('no-delete-id')).toBe(false);
  });

  it('transferNoDeleteMarker moves it explicitly between two nodes', () => {
    const a = document.createElement('p'); a.id = '1'; a.setAttribute('no-delete-id', 'please');
    const b = document.createElement('p'); b.id = '2';
    document.body.append(a, b);
    transferNoDeleteMarker(a, b);
    expect(a.hasAttribute('no-delete-id')).toBe(false);
    expect(b.getAttribute('no-delete-id')).toBe('please');
  });

  it('findNextNoDeleteNode returns the first numeric non-sentinel node', () => {
    const host = document.createElement('div'); host.className = 'main-content';
    host.innerHTML = '<div id="b-top-sentinel"></div><p id="1">a</p><p id="2">b</p>';
    document.body.appendChild(host);
    expect(findNextNoDeleteNode(host).id).toBe('1');
  });
});

describe('cleanupStyledSpans', () => {
  it('removes span[style] wrappers but preserves their text', () => {
    const host = document.createElement('div');
    host.innerHTML = 'a <span style="color:red">red</span> b';
    document.body.appendChild(host);
    cleanupStyledSpans(host);
    expect(host.querySelector('span')).toBeNull();
    expect(host.textContent).toBe('a red b');
  });
});
