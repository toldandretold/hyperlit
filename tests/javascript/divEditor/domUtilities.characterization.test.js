/**
 * Characterization of the cleanly-testable helpers in
 * resources/js/divEditor/domUtilities.ts — numeric-node collection and
 * styled-span cleanup. (The no-delete-id marker system that used to be
 * pinned here is RETIRED — the last-node invariant is now the runtime
 * lastNodeGuard, see lastNodeGuard.characterization.test.js.)
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
