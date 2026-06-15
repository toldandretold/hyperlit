/**
 * Characterization of resources/js/hyperlights/annotations.js — saving a
 * highlight's annotation HTML into the hyperlights store + queuing PG sync.
 * Pinned before .js → .ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from '../indexedDB/idbHarness.js';

const { queueForSync, updateAnnotationsTimestamp } = vi.hoisted(() => ({
  queueForSync: vi.fn(),
  updateAnnotationsTimestamp: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/operationState.js', () => ({ withPending: (fn) => fn() }));
vi.mock('../../../resources/js/hyperlitContainer/stack', () => ({ getCurrentContainer: () => null }));
vi.mock('../../../resources/js/indexedDB/index.js', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  return { openDatabase: conn.openDatabase, queueForSync, updateAnnotationsTimestamp };
});

import {
  getAnnotationHTML,
  saveAnnotationToIndexedDB,
  saveHighlightAnnotation,
} from '../../../resources/js/hyperlights/annotations';

beforeEach(() => {
  installFreshIndexedDB();
  vi.clearAllMocks();
});

describe('getAnnotationHTML', () => {
  it('reads .annotation innerHTML, or "" when absent', () => {
    const c = document.createElement('div');
    c.innerHTML = '<div class="annotation"><b>hi</b></div>';
    expect(getAnnotationHTML(c)).toBe('<b>hi</b>');
    expect(getAnnotationHTML(document.createElement('div'))).toBe('');
  });
});

describe('saveAnnotationToIndexedDB', () => {
  it('writes the annotation onto the hyperlight record and queues it for sync', async () => {
    await seedStore('hyperlights', [{ book: 'bookA', hyperlight_id: 'HL_x', annotation: '' }]);

    await saveAnnotationToIndexedDB('HL_x', '<b>note</b>');

    expect((await readOne('hyperlights', ['bookA', 'HL_x'])).annotation).toBe('<b>note</b>');
    expect(queueForSync).toHaveBeenCalledWith('hyperlights', 'HL_x', 'update', expect.objectContaining({ annotation: '<b>note</b>' }));
    // this entry point does NOT bump the annotations timestamp
    expect(updateAnnotationsTimestamp).not.toHaveBeenCalled();
  });

  it('throws when there is no record', async () => {
    await expect(saveAnnotationToIndexedDB('missing', 'x')).rejects.toThrow('No highlight record');
  });
});

describe('saveHighlightAnnotation', () => {
  it('writes annotation, queues sync, AND bumps the annotations timestamp', async () => {
    await seedStore('hyperlights', [{ book: 'bookA', hyperlight_id: 'HL_y', annotation: '' }]);

    await saveHighlightAnnotation('HL_y', 'noted');

    expect((await readOne('hyperlights', ['bookA', 'HL_y'])).annotation).toBe('noted');
    expect(queueForSync).toHaveBeenCalledWith('hyperlights', 'HL_y', 'update', expect.objectContaining({ annotation: 'noted' }));
    expect(updateAnnotationsTimestamp).toHaveBeenCalledWith('bookA');
  });

  it('no-ops on a falsy id or a missing record', async () => {
    await saveHighlightAnnotation('', 'x');
    await saveHighlightAnnotation('absent', 'x');
    expect(queueForSync).not.toHaveBeenCalled();
  });
});
