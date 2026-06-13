/**
 * Characterization of the testable bits of supDeleteHandler
 * (divEditor/supTagHandler/deleteHandler.ts): the block-merge queue calls and
 * the footnote confirm-decline guard. The async source-<u>→tombstone path and
 * the dynamic-import branches lean on the e2e grand tour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave, queueNodeForDeletion } = vi.hoisted(() => ({
  queueNodeForSave: vi.fn(), queueNodeForDeletion: vi.fn(),
}));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave, queueNodeForDeletion }));
vi.mock('../../../resources/js/indexedDB/syncQueue/queue', () => ({ queueForSync: vi.fn() }));

import { supDeleteHandler } from '../../../resources/js/divEditor/supTagHandler/deleteHandler.ts';

beforeEach(() => { document.body.innerHTML = ''; window.isEditing = true; vi.clearAllMocks(); });
function cursorAt(node, offset) {
  const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
const ev = (over) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over });

describe('supDeleteHandler — block merge into a paragraph that starts with a sup', () => {
  it('forward-delete merges the next block in and queues delete+update', () => {
    document.body.innerHTML = '<p id="1">aaa</p><p id="2"><sup fn-count-id="9">3</sup>bbb</p>';
    const p1 = document.getElementById('1');
    const p2 = document.getElementById('2');
    cursorAt(p1.firstChild, 3);                       // end of "aaa"

    const e = ev({ inputType: 'deleteContentForward' });
    supDeleteHandler(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(queueNodeForDeletion).toHaveBeenCalledWith('2', p2);   // removed block
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update'); // surviving block
    expect(document.getElementById('2')).toBeNull();              // p#2 merged away
    expect(p1.querySelector('sup')).not.toBeNull();               // sup moved into p#1
  });
});

describe('supDeleteHandler — footnote deletion confirm', () => {
  it('declining the confirm blocks the delete and keeps the sup', () => {
    document.body.innerHTML = '<p id="1">aaa<sup fn-count-id="3" id="Fn3">5</sup></p>';
    const sup = document.querySelector('sup');
    cursorAt(sup.firstChild, 1);                      // end of the sup content

    const confirmSpy = vi.fn().mockReturnValue(false);
    window.confirm = confirmSpy;                       // happy-dom has no confirm to spy on
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);

    expect(confirmSpy).toHaveBeenCalledWith('Delete footnote 3?');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.querySelector('sup')).not.toBeNull();         // not deleted
  });
});
