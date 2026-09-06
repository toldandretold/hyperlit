/**
 * imageDrop — edit-mode drag-and-drop image insertion. Pins the two hazard
 * guards (file-drag dragover preventDefault; beforeinput insertFromDrop
 * swallowed while active and NOT after removal), the drop-point resolution
 * (rect midpoint → before/after; outside content → no-op), and the file
 * filtering hand-off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { insertImageFiles } = vi.hoisted(() => ({ insertImageFiles: vi.fn().mockResolvedValue({ inserted: [], failed: [], skipped: [] }) }));
vi.mock('../../../resources/js/divEditor/imageDrop/insertImageFiles', () => ({ insertImageFiles }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: new Proxy({}, { get: () => vi.fn() }),
  verbose: new Proxy({}, { get: () => vi.fn() }),
  isVerboseEnabled: () => false,
}));

import { addImageDropListener, removeImageDropListener } from '../../../resources/js/divEditor/imageDrop/index';

const BOOK = 'book_drop';

function buildEditor() {
  const editable = document.createElement('div');
  editable.id = BOOK;
  editable.setAttribute('data-book-id', BOOK);
  editable.setAttribute('contenteditable', 'true');
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  for (const id of ['100', '200']) {
    const p = document.createElement('p');
    p.id = id;
    p.setAttribute('data-node-id', `${BOOK}_seed_${id}`);
    p.textContent = `node ${id}`;
    chunk.appendChild(p);
  }
  editable.appendChild(chunk);
  document.body.appendChild(editable);
  return { editable, chunk };
}

/** Stub rects: node 100 occupies y 0-100, node 200 occupies y 100-200. */
function stubGeometry() {
  const n100 = document.getElementById('100');
  const n200 = document.getElementById('200');
  n100.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: 0 });
  n200.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 500, width: 500, height: 100, x: 0, y: 100 });
  document.elementFromPoint = (x, y) => {
    if (y < 0 || y >= 200 || x < 0 || x > 500) return document.body;
    return y < 100 ? n100 : n200;
  };
}

function dragEvent(type, { x = 10, y = 10, files = [], fileDrag = true } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.clientX = x;
  e.clientY = y;
  e.dataTransfer = fileDrag ? { types: ['Files'], files, dropEffect: '' } : { types: ['text/plain'], files: [], dropEffect: '' };
  return e;
}

function flushRaf() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const pngFile = (name = 'pic.png') => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(() => {
  removeImageDropListener();
});

describe('imageDrop hazard guards', () => {
  it('preventDefaults every file-drag dragover while active', () => {
    const { editable } = buildEditor();
    addImageDropListener(editable, BOOK);

    const over = dragEvent('dragover');
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');

    const textOver = dragEvent('dragover', { fileDrag: false });
    window.dispatchEvent(textOver);
    expect(textOver.defaultPrevented).toBe(false);
  });

  it('swallows beforeinput insertFromDrop while active, not after removal', () => {
    const { editable } = buildEditor();
    addImageDropListener(editable, BOOK);

    const drop = new Event('beforeinput', { bubbles: true, cancelable: true });
    drop.inputType = 'insertFromDrop';
    editable.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    const paste = new Event('beforeinput', { bubbles: true, cancelable: true });
    paste.inputType = 'insertFromPaste';
    editable.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);

    removeImageDropListener();
    const afterRemove = new Event('beforeinput', { bubbles: true, cancelable: true });
    afterRemove.inputType = 'insertFromDrop';
    editable.dispatchEvent(afterRemove);
    expect(afterRemove.defaultPrevented).toBe(false);
  });
});

describe('imageDrop target resolution', () => {
  it('drops onto the top half → insert BEFORE that node', () => {
    const { editable } = buildEditor();
    stubGeometry();
    addImageDropListener(editable, BOOK);

    const file = pngFile();
    window.dispatchEvent(dragEvent('drop', { y: 120, files: [file] }));

    expect(insertImageFiles).toHaveBeenCalledTimes(1);
    const [files, anchor, position, bookId] = insertImageFiles.mock.calls[0];
    expect(files).toEqual([file]);
    expect(anchor.id).toBe('200');
    expect(position).toBe('before');
    expect(bookId).toBe(BOOK);
  });

  it('drops onto the bottom half → insert AFTER that node', () => {
    const { editable } = buildEditor();
    stubGeometry();
    addImageDropListener(editable, BOOK);

    window.dispatchEvent(dragEvent('drop', { y: 90, files: [pngFile()] }));

    const [, anchor, position] = insertImageFiles.mock.calls[0];
    expect(anchor.id).toBe('100');
    expect(position).toBe('after');
  });

  it('drop outside the content is a no-op (but still preventDefaulted)', () => {
    const { editable } = buildEditor();
    stubGeometry();
    addImageDropListener(editable, BOOK);

    const e = dragEvent('drop', { y: 300, files: [pngFile()] });
    window.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    expect(insertImageFiles).not.toHaveBeenCalled();
  });

  it('shows and positions the indicator during dragover, hides it on drop', async () => {
    const { editable } = buildEditor();
    stubGeometry();
    addImageDropListener(editable, BOOK);

    window.dispatchEvent(dragEvent('dragenter'));
    window.dispatchEvent(dragEvent('dragover', { y: 120 }));
    await flushRaf();

    const indicator = document.querySelector('.image-drop-indicator');
    expect(indicator.style.display).toBe('block');
    expect(indicator.style.top).toBe('98.5px'); // node 200 top edge (before)
    expect(document.getElementById('image-drop-overlay').style.display).toBe('block');

    window.dispatchEvent(dragEvent('drop', { y: 120, files: [pngFile()] }));
    expect(indicator.style.display).toBe('none');
    expect(document.getElementById('image-drop-overlay').style.display).toBe('none');
  });

  it('removal detaches the window listeners entirely', () => {
    const { editable } = buildEditor();
    stubGeometry();
    addImageDropListener(editable, BOOK);
    removeImageDropListener();

    const over = dragEvent('dragover');
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);

    window.dispatchEvent(dragEvent('drop', { y: 120, files: [pngFile()] }));
    expect(insertImageFiles).not.toHaveBeenCalled();
  });
});
