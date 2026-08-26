/**
 * SelectionDeletionHandler.handlePostDeletion — the "only delete what actually
 * left the DOM" contract.
 *
 * affectedElementIds is captured at KEYDOWN time; the keyup fallback then runs
 * handlePostDeletion even when a keydown guard preventDefaulted the edit (the
 * last-node guard) or the browser didn't delete. Queueing those ids destroyed
 * LIVE content in IDB + on the server. Still-connected nodes must be skipped;
 * genuinely removed ones must still be deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/indexedDB/index.js', () => ({
  batchDeleteIndexedDBRecords: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../resources/js/indexedDB/syncQueue/queue', () => ({
  queueForSync: vi.fn(),
}));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setUserDeletionInProgress: vi.fn(),
}));

import { SelectionDeletionHandler } from '../../../resources/js/divEditor/selectionDelete.js';

let editor, queueNodeForDeletion, queueNodeForSave, handler;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  editor = document.createElement('div');
  editor.className = 'main-content';
  document.body.appendChild(editor);
  queueNodeForDeletion = vi.fn();
  queueNodeForSave = vi.fn();
  handler = new SelectionDeletionHandler(editor, { queueNodeForDeletion, queueNodeForSave });
});

// handlePostDeletion arms a 100ms setTimeout that dynamic-imports
// operationState to clear the deletion flag — let it resolve INSIDE the test
// environment or vitest reports an unhandled rejection at teardown.
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('handlePostDeletion', () => {
  it('deletes only nodes that actually left the DOM; still-connected nodes are spared', async () => {
    // "5" survived (the guard blocked the edit); "6" is genuinely gone.
    editor.innerHTML = '<div class="chunk"><p id="5">survivor</p></div>';
    handler.pendingDeletion = {
      affectedElementIds: ['5', '6'],
      boundaryElementIds: [],
    };

    handler.handlePostDeletion();

    expect(queueNodeForDeletion).toHaveBeenCalledTimes(1);
    expect(queueNodeForDeletion).toHaveBeenCalledWith('6');
    expect(handler.pendingDeletion).toBeNull();
    await settle();
  });

  it('boundary elements still in the DOM are updated, not deleted', async () => {
    editor.innerHTML = '<div class="chunk"><p id="7">boundary text</p></div>';
    handler.pendingDeletion = {
      affectedElementIds: [],
      boundaryElementIds: ['7', '8'], // 7 exists (update), 8 gone (delete)
    };

    handler.handlePostDeletion();

    expect(queueNodeForSave).toHaveBeenCalledWith('7', 'update');
    expect(queueNodeForDeletion).toHaveBeenCalledTimes(1);
    expect(queueNodeForDeletion).toHaveBeenCalledWith('8');
    await settle();
  });
});
