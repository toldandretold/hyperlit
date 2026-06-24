/**
 * adoptPrerenderedChunk — the client half of Phase 2 "server injects the first chunk, client
 * adopts it without re-rendering". This pins the contract: given a server-rendered
 * `<div class="chunk" data-prerendered>` in the container, the module registers it as a loaded
 * chunk (so the lazy loader never re-renders it), layers the per-user/client-only passes on top
 * (annotations via reprocessHighlightsForNodes, footnote numbers, math/charts/images), and fires
 * the first-chunk callback — and on ANY failure cleanly removes the element and returns null so
 * the normal render path can take over (no half-adopted DOM).
 *
 * The factory-side counterpart (an already-registered chunk → loadChunkInternal does NOT call
 * createChunkElement) lives in createLazyLoader.test.js; together they prove "no re-render".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Seams the module calls — stub them so this stays a pure register/dispatch check.
vi.mock('../../../resources/js/hyperlights/deletion', () => ({
  reprocessHighlightsForNodes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
  renderMathElements: vi.fn(),
  normalizeHyperciteElements: vi.fn(),
  ensureNoDeleteMarkerForBook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/lazyLoader/chartRenderer', () => ({ renderCharts: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageState', () => ({ handleBrokenImages: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/footnoteSelfHeal', () => ({ applyDynamicFootnoteNumbers: vi.fn() }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  verbose: { content: vi.fn() },
  log: { content: vi.fn() },
}));

// parseChunkId is kept REAL (it is the parseFloat-based, decimal-aware id helper under test for #3).
import { adoptPrerenderedChunk } from '../../../resources/js/lazyLoader/adoptPrerenderedChunk';
import { reprocessHighlightsForNodes } from '../../../resources/js/hyperlights/deletion';
import { renderMathElements, normalizeHyperciteElements, ensureNoDeleteMarkerForBook } from '../../../resources/js/lazyLoader/chunkRender';
import { renderCharts } from '../../../resources/js/lazyLoader/chartRenderer';
import { handleBrokenImages } from '../../../resources/js/lazyLoader/imageState';
import { applyDynamicFootnoteNumbers } from '../../../resources/js/lazyLoader/footnoteSelfHeal';

/** A minimal lazy-loader instance shape (only what adoptPrerenderedChunk touches). */
function buildInstance({ nodes = [], onFirstChunkLoadedCallback = null } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    nodes,
    currentlyLoadedChunks: new Set(),
    attachMarkListeners: vi.fn(),
    attachUnderlineClickListeners: vi.fn(),
    onFirstChunkLoadedCallback,
  };
}

/** Inject a server-rendered chunk into the instance container (one <p> per node content). */
function injectPrerenderedChunk(instance, chunkId, children = []) {
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', String(chunkId));
  chunk.setAttribute('data-prerendered', 'true');
  for (const c of children) {
    const p = document.createElement('p');
    if (c.id) p.id = c.id;
    if (c.nodeId) p.setAttribute('data-node-id', c.nodeId);
    p.textContent = c.text || '';
    chunk.appendChild(p);
  }
  instance.container.appendChild(chunk);
  return chunk;
}

const node = (chunkId, startLine, nodeId) => ({
  book: 'bookA', chunk_id: chunkId, startLine, node_id: nodeId,
  content: `node ${startLine}`, plainText: `node ${startLine}`, type: null,
  footnotes: [], hyperlights: [], hypercites: [], raw_json: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('adoptPrerenderedChunk', () => {
  it('returns null (no throw) when there is nothing to adopt', async () => {
    expect(await adoptPrerenderedChunk(null, 'bookA')).toBeNull();
    expect(await adoptPrerenderedChunk({}, 'bookA')).toBeNull();
    // container present but no prerendered chunk in it
    const instance = buildInstance();
    expect(await adoptPrerenderedChunk(instance, 'bookA')).toBeNull();
    expect(reprocessHighlightsForNodes).not.toHaveBeenCalled();
  });

  it('adopts the chunk: registers it, strips the marker, applies passes + listeners, returns the id', async () => {
    const instance = buildInstance({ nodes: [node(0, '100', 'N100'), node(0, '101', 'N101')] });
    const chunk = injectPrerenderedChunk(instance, 0, [
      { id: '100', nodeId: 'N100', text: 'a' },
      { id: '101', nodeId: 'N101', text: 'b' },
    ]);

    const result = await adoptPrerenderedChunk(instance, 'bookA');

    expect(result).toBe(0);
    expect(instance.currentlyLoadedChunks.has(0)).toBe(true);      // registered as loaded
    expect(chunk.hasAttribute('data-prerendered')).toBe(false);    // marker stripped (adopted)

    // annotations applied to the live DOM, with the chunk's node ids + records
    expect(reprocessHighlightsForNodes).toHaveBeenCalledTimes(1);
    const [book, ids, records] = reprocessHighlightsForNodes.mock.calls[0];
    expect(book).toBe('bookA');
    expect(ids).toEqual(['100', '101']);
    expect(records).toHaveLength(2);

    // client-only render passes ran on the chunk element
    expect(renderMathElements).toHaveBeenCalledWith(chunk);
    expect(renderCharts).toHaveBeenCalledWith(chunk);
    expect(handleBrokenImages).toHaveBeenCalledWith(chunk);
    expect(normalizeHyperciteElements).toHaveBeenCalledWith(chunk);
    expect(applyDynamicFootnoteNumbers).toHaveBeenCalledTimes(2); // once per node element
    expect(ensureNoDeleteMarkerForBook).toHaveBeenCalledWith(chunk, instance.nodes);

    // listeners wired scoped to the adopted chunk (not document-wide)
    expect(instance.attachMarkListeners).toHaveBeenCalledWith(chunk);
    expect(instance.attachUnderlineClickListeners).toHaveBeenCalledWith(chunk);
  });

  it('preserves a DECIMAL chunk id (4.5 registered, not 4)', async () => {
    const instance = buildInstance({ nodes: [node(4.5, '450', 'N450')] });
    injectPrerenderedChunk(instance, 4.5, [{ id: '450', nodeId: 'N450' }]);

    const result = await adoptPrerenderedChunk(instance, 'bookA');

    expect(result).toBe(4.5);
    expect(instance.currentlyLoadedChunks.has(4.5)).toBe(true);
    expect(instance.currentlyLoadedChunks.has(4)).toBe(false);
  });

  it('defensively sets id=startLine + data-node-id only when missing', async () => {
    const instance = buildInstance({ nodes: [node(0, '100', 'N100'), node(0, '101', 'N101')] });
    // first child has NO id/data-node-id; second already carries them
    const chunk = injectPrerenderedChunk(instance, 0, [
      { text: 'no ids yet' },
      { id: '999', nodeId: 'KEEP', text: 'already set' },
    ]);

    await adoptPrerenderedChunk(instance, 'bookA');

    const [first, second] = chunk.children;
    expect(first.id).toBe('100');                       // set from the node record
    expect(first.getAttribute('data-node-id')).toBe('N100');
    expect(second.id).toBe('999');                      // existing id NOT overwritten
    expect(second.getAttribute('data-node-id')).toBe('KEEP');
  });

  it('discards (removes element, returns null) when no nodes match the chunk', async () => {
    const instance = buildInstance({ nodes: [node(7, '700', 'N700')] }); // only chunk 7 in records
    injectPrerenderedChunk(instance, 0, [{ id: '100', nodeId: 'N100' }]); // injected chunk 0

    const result = await adoptPrerenderedChunk(instance, 'bookA');

    expect(result).toBeNull();
    expect(instance.container.querySelector('.chunk')).toBeNull(); // removed
    expect(reprocessHighlightsForNodes).not.toHaveBeenCalled();
  });

  it('fires the first-chunk callback exactly once, then nullifies it', async () => {
    const cb = vi.fn();
    const instance = buildInstance({ nodes: [node(0, '100', 'N100')], onFirstChunkLoadedCallback: cb });
    injectPrerenderedChunk(instance, 0, [{ id: '100', nodeId: 'N100' }]);

    await adoptPrerenderedChunk(instance, 'bookA');

    expect(cb).toHaveBeenCalledTimes(1);
    expect(instance.onFirstChunkLoadedCallback).toBeNull();
  });

  it('on a pass failure: removes the server DOM and returns null (clean fallback, no half-adopt)', async () => {
    reprocessHighlightsForNodes.mockRejectedValueOnce(new Error('boom'));
    const instance = buildInstance({ nodes: [node(0, '100', 'N100')] });
    injectPrerenderedChunk(instance, 0, [{ id: '100', nodeId: 'N100' }]);

    const result = await adoptPrerenderedChunk(instance, 'bookA');

    expect(result).toBeNull();
    expect(instance.container.querySelector('.chunk')).toBeNull();  // discarded
    expect(instance.currentlyLoadedChunks.has(0)).toBe(false);      // never registered
  });
});
