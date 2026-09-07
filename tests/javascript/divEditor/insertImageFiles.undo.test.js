/**
 * insertImageFiles — undo integration. Each successful image insert records a
 * 'format' undo entry anchored on the NEIGHBOUR node (which exists in both
 * undo/redo states): undoFn removes the img + queues a deletion, redoFn
 * re-inserts it on the original side of the anchor + queues an 'add'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave, queueNodeForDeletion, recordFormat, sealGroup, updateUndoRedo } = vi.hoisted(() => ({
  queueNodeForSave: vi.fn(),
  queueNodeForDeletion: vi.fn(),
  recordFormat: vi.fn(),
  sealGroup: vi.fn(),
  updateUndoRedo: vi.fn(),
}));

vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave, queueNodeForDeletion }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: new Proxy({}, { get: () => vi.fn() }),
  verbose: new Proxy({}, { get: () => vi.fn() }),
  isVerboseEnabled: () => false,
}));
vi.mock('../../../resources/js/utilities/bookImageUpload', () => ({
  isInsertableImageFile: () => true,
  uploadBookImage: vi.fn().mockResolvedValue({
    filename: 'ab12-pic.png', width: 10, height: 10,
    src: '/book_u/media/ab12-pic.png', encrypted: false,
  }),
}));
vi.mock('../../../resources/js/editToolbar/index', () => ({
  getEditToolbar: () => ({
    undoManager: { recordFormat, sealGroup },
    _updateUndoRedoButtons: updateUndoRedo,
  }),
}));
// Real insertBlockNode would pull idHelpers/app — stub it with a plain DOM insert.
vi.mock('../../../resources/js/divEditor/insertBlockNode', () => ({
  insertBlockNodeAfter: (anchor, el) => {
    el.id = '150';
    el.setAttribute('data-node-id', 'book_u_1_x');
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    return el;
  },
  insertBlockNodeBefore: (anchor, el) => {
    el.id = '50';
    el.setAttribute('data-node-id', 'book_u_1_y');
    anchor.parentNode.insertBefore(el, anchor);
    return el;
  },
}));

import { insertImageFiles } from '../../../resources/js/divEditor/imageDrop/insertImageFiles';

const BOOK = 'book_u';

function buildChunk() {
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  const p = document.createElement('p');
  p.id = '100';
  p.textContent = 'anchor paragraph';
  chunk.appendChild(p);
  document.body.appendChild(chunk);
  return { chunk, p };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('insertImageFiles undo wiring', () => {
  it('records a format entry anchored on the neighbour; undoFn/redoFn round-trip', async () => {
    const { chunk, p } = buildChunk();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });

    const result = await insertImageFiles([file], p, 'after', BOOK);
    expect(result.inserted).toHaveLength(1);
    const img = result.inserted[0];
    expect(img.tagName).toBe('IMG');

    expect(sealGroup).toHaveBeenCalled();
    expect(recordFormat).toHaveBeenCalledTimes(1);
    const [anchorId, undoFn, redoFn, bookId] = recordFormat.mock.calls[0];
    expect(anchorId).toBe('100'); // the neighbour, NOT the img (must resolve in both states)
    expect(bookId).toBe(BOOK);
    expect(updateUndoRedo).toHaveBeenCalledWith(BOOK);

    // UNDO: img removed + deletion queued; returns the anchor for caret/save.
    const undoReturn = undoFn(p);
    expect(undoReturn).toBe(p);
    expect(document.getElementById('150')).toBeNull();
    expect(queueNodeForDeletion).toHaveBeenCalledWith('150', img, BOOK);

    // REDO: img re-inserted AFTER the anchor + 'add' queued.
    const redoReturn = redoFn(p);
    expect(redoReturn).toBe(p);
    expect(document.getElementById('150')).toBe(img);
    expect(p.nextElementSibling).toBe(img);
    expect(queueNodeForSave).toHaveBeenCalledWith('150', 'add', BOOK);

    // Redo is idempotent when the img is already present.
    queueNodeForSave.mockClear();
    redoFn(p);
    expect(chunk.querySelectorAll('img')).toHaveLength(1);
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });

  it('insert-before records the anchor side so redo restores the original position', async () => {
    const { p } = buildChunk();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });

    const result = await insertImageFiles([file], p, 'before', BOOK);
    const img = result.inserted[0];
    expect(p.previousElementSibling).toBe(img);

    const [anchorId, undoFn, redoFn] = recordFormat.mock.calls[0];
    expect(anchorId).toBe('100');

    undoFn(p);
    expect(document.getElementById('50')).toBeNull();
    redoFn(p);
    expect(p.previousElementSibling).toBe(img); // BEFORE the anchor, as originally
  });
});
