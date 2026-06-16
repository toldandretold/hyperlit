/**
 * Characterization of resources/js/divEditor/editorState.ts — the shared editor
 * state + SaveQueue enqueue API extracted from index.js to break the
 * index↔handler circular import. Pins the chokepoint behavior + the wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/utilities/IDfunctions', () => ({ NUMERICAL_ID_PATTERN: /^\d+(\.\d+)?$/ }));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({ glowCloudOrange: vi.fn() }));

import {
  movedNodesByOverflow, queueNodeForSave, queueNodeForDeletion,
  setActiveSaveQueue, getActiveSaveQueue,
} from '../../../resources/js/divEditor/editorState';

let warnSpy;
beforeEach(() => {
  setActiveSaveQueue(null);
  movedNodesByOverflow.clear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warnSpy.mockClear();   // console.warn is one shared spy across tests — reset its call log
});

describe('queue API delegation + guard', () => {
  it('warns and no-ops when no SaveQueue is wired in', () => {
    queueNodeForSave('3', 'update');
    queueNodeForDeletion('3');
    expect(warnSpy.mock.calls.some(a => String(a[0]).includes('not initialized'))).toBe(true);
  });

  it('drops non-numeric ids BEFORE the not-initialized check (numeric guard runs first)', () => {
    queueNodeForSave('hypercite_x', 'update');
    expect(warnSpy.mock.calls.some(a => String(a[0]).includes('not initialized'))).toBe(false);
  });

  it('delegates to the wired SaveQueue instance', () => {
    const sq = { queueNode: vi.fn(), queueDeletion: vi.fn() };
    setActiveSaveQueue(sq);
    expect(getActiveSaveQueue()).toBe(sq);

    queueNodeForSave('3', 'update', 'bookA');
    expect(sq.queueNode).toHaveBeenCalledWith('3', 'update', 'bookA');

    queueNodeForSave('abc');                 // numeric guard → no delegation
    expect(sq.queueNode).toHaveBeenCalledTimes(1);

    const el = document.createElement('p');
    queueNodeForDeletion('5', el, 'bookB');
    expect(sq.queueDeletion).toHaveBeenCalledWith('5', el, 'bookB');
  });
});

describe('movedNodesByOverflow', () => {
  it('is a shared mutable Set', () => {
    movedNodesByOverflow.add('7');
    expect(movedNodesByOverflow.has('7')).toBe(true);
    movedNodesByOverflow.delete('7');
    expect(movedNodesByOverflow.has('7')).toBe(false);
  });
});
