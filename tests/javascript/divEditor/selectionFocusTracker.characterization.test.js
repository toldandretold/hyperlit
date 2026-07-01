/**
 * Characterization of selectionFocusTracker (divEditor/selectionFocusTracker.ts):
 * updateChunkFocus (only bumps chunk-focus state when it actually changed, and never
 * while not editing / mid overflow / formatting) and rescueCaretFromSentinel (moves the
 * caret out of a sentinel div to the nearest valid node). Collaborators are mocked;
 * currentObservedChunk is pinned to 'A' in the operationState mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getCurrentChunk, setCurrentObservedChunk, getEditToolbar, isEventInActiveDiv } = vi.hoisted(() => ({
  getCurrentChunk: vi.fn(),
  setCurrentObservedChunk: vi.fn(),
  getEditToolbar: vi.fn(() => null),
  isEventInActiveDiv: vi.fn(() => true),
}));

vi.mock('../../../resources/js/utilities/operationState', () => ({
  chunkOverflowInProgress: false,
  currentObservedChunk: 'A',
  setCurrentObservedChunk,
}));
vi.mock('../../../resources/js/editToolbar/index', () => ({ getEditToolbar }));
vi.mock('../../../resources/js/divEditor/chunkManager', () => ({ getCurrentChunk }));
vi.mock('../../../resources/js/divEditor/editSessionManager', () => ({ isEventInActiveDiv }));
vi.mock('../../../resources/js/app', () => ({ book: 'editable' }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn(), user: vi.fn() } }));

import { updateChunkFocus, rescueCaretFromSentinel } from '../../../resources/js/divEditor/selectionFocusTracker';

beforeEach(() => { document.body.innerHTML = ''; window.isEditing = true; vi.clearAllMocks(); getEditToolbar.mockReturnValue(null); });

describe('updateChunkFocus', () => {
  it('updates state when focus moved to a different chunk', () => {
    getCurrentChunk.mockReturnValue('B');
    updateChunkFocus();
    expect(setCurrentObservedChunk).toHaveBeenCalledWith('B');
  });

  it('does nothing when the chunk is unchanged', () => {
    getCurrentChunk.mockReturnValue('A');            // === currentObservedChunk
    updateChunkFocus();
    expect(setCurrentObservedChunk).not.toHaveBeenCalled();
  });

  it('does nothing when not editing', () => {
    window.isEditing = false;
    getCurrentChunk.mockReturnValue('B');
    updateChunkFocus();
    expect(setCurrentObservedChunk).not.toHaveBeenCalled();
  });

  it('does nothing while the toolbar is formatting', () => {
    getEditToolbar.mockReturnValue({ isFormatting: true });
    getCurrentChunk.mockReturnValue('B');
    updateChunkFocus();
    expect(setCurrentObservedChunk).not.toHaveBeenCalled();
  });
});

describe('rescueCaretFromSentinel', () => {
  it('returns false for a non-sentinel element', () => {
    document.body.innerHTML = '<div id="editable"><p id="5">x</p></div>';
    const p = document.querySelector('[id="5"]');
    expect(rescueCaretFromSentinel(p, window.getSelection())).toBe(false);
  });

  it('moves the caret to the first valid node and returns true for a sentinel', () => {
    document.body.innerHTML =
      '<div id="editable"><p id="5">valid</p><div id="b-top-sentinel"></div></div>';
    const sentinel = document.querySelector('[id="b-top-sentinel"]');
    const sel = window.getSelection();

    const result = rescueCaretFromSentinel(sentinel, sel);

    expect(result).toBe(true);
    // Caret now sits inside the valid node, not the sentinel.
    const anchor = sel.anchorNode;
    const anchorEl = anchor && (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor);
    expect(anchorEl?.closest('[id="5"]')).not.toBeNull();
  });
});
