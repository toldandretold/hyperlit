/**
 * Characterization of the testable bits of supDeleteHandler
 * (divEditor/supTagHandler/deleteHandler.ts): the block-merge queue calls and
 * the footnote/hypercite confirm flows. The async source-<u>→tombstone path and
 * the dynamic-import branches lean on the e2e grand tour.
 *
 * The confirm flows use the app confirmDialog (components/dialog/dialog), NOT
 * native window.confirm — iOS Safari suppresses native modals inside
 * beforeinput (confirm returns false with no UI), which silently blocked all
 * deletion near hypercites/footnotes. The key invariant locked here:
 * preventDefault fires SYNCHRONOUSLY, before the dialog promise settles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave, queueNodeForDeletion, queueForSync, confirmDialog } = vi.hoisted(() => ({
  queueNodeForSave: vi.fn(), queueNodeForDeletion: vi.fn(),
  queueForSync: vi.fn(), confirmDialog: vi.fn(),
}));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave, queueNodeForDeletion }));
vi.mock('../../../resources/js/indexedDB/syncQueue/queue', () => ({ queueForSync }));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({ confirmDialog }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { user: vi.fn(), error: vi.fn() },
  verbose: { user: vi.fn(), content: vi.fn() },
}));
// idHelpers transitively imports app.ts (module side effects) — stub the one helper used.
vi.mock('../../../resources/js/utilities/idHelpers', () => ({ asBookId: (s) => s }));

import { supDeleteHandler } from '../../../resources/js/divEditor/supTagHandler/deleteHandler';

beforeEach(() => { document.body.innerHTML = ''; window.isEditing = true; vi.clearAllMocks(); });
function cursorAt(node, offset) {
  const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
const ev = (over) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));

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
  function mountFootnote() {
    document.body.innerHTML =
      '<div class="main-content" id="bookX"><p id="1">aaa<sup fn-count-id="3" id="Fn3">5</sup></p></div>';
    const sup = document.querySelector('sup');
    cursorAt(sup.firstChild, 1);                       // end of the sup content
    return sup;
  }

  it('preventDefaults synchronously, BEFORE the dialog settles (the iOS invariant)', async () => {
    mountFootnote();
    let resolveDialog;
    confirmDialog.mockReturnValue(new Promise((r) => { resolveDialog = r; }));
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);

    expect(e.preventDefault).toHaveBeenCalled();           // sync, dialog still pending
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(document.querySelector('sup')).not.toBeNull();  // nothing deleted yet

    resolveDialog(false);                                  // release the in-flight guard
    await flush();
  });

  it('declining the confirm keeps the sup and queues nothing', async () => {
    mountFootnote();
    confirmDialog.mockResolvedValue(false);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith({ message: 'Delete footnote 3?', danger: true });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.querySelector('sup')).not.toBeNull();  // not deleted
    expect(queueForSync).not.toHaveBeenCalled();
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });

  it('confirming removes the whole sup, queues the delink and the parent update', async () => {
    mountFootnote();
    confirmDialog.mockResolvedValue(true);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);
    await flush();

    expect(document.querySelector('sup')).toBeNull();      // removed manually
    expect(queueForSync).toHaveBeenCalledWith('footnotes', 'Fn3', 'delete', { book: 'bookX', footnoteId: 'Fn3' });
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update');
  });

  it('multi-digit sup: confirming deletes the WHOLE marker, not one digit', async () => {
    // Regression: the pre-dialog code let the browser default proceed on
    // confirm, deleting only the last digit of <sup>111</sup>.
    document.body.innerHTML =
      '<div class="main-content" id="bookX"><p id="1">aaa<sup fn-count-id="111" id="Fn111">111</sup></p></div>';
    const sup = document.querySelector('sup');
    cursorAt(sup.firstChild, 3);                       // caret at end of "111"

    confirmDialog.mockResolvedValue(true);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith({ message: 'Delete footnote 111?', danger: true });
    expect(document.querySelector('sup')).toBeNull();      // whole marker gone
    expect(document.getElementById('1').textContent).toBe('aaa');
    expect(queueForSync).toHaveBeenCalledWith('footnotes', 'Fn111', 'delete', { book: 'bookX', footnoteId: 'Fn111' });
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update');
  });
});

describe('supDeleteHandler — backspace with caret immediately AFTER a footnote sup', () => {
  // Previously unguarded: only hypercite anchors were matched in the
  // backspace-after position, so this silently ate the sup's last digit.
  function mountAfterSup() {
    document.body.innerHTML =
      '<div class="main-content" id="bookX"><p id="1">aaa<sup fn-count-id="3" id="Fn3">111</sup>tail</p></div>';
    const sup = document.querySelector('sup');
    cursorAt(sup.nextSibling, 0);                      // caret at start of "tail" = just after the sup
    return sup;
  }

  it('shows the confirm (preventDefault synchronous); declining keeps the sup', async () => {
    mountAfterSup();
    confirmDialog.mockResolvedValue(false);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);

    expect(e.preventDefault).toHaveBeenCalled();           // sync, before dialog settles
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith({ message: 'Delete footnote 3?', danger: true });
    expect(document.querySelector('sup')).not.toBeNull();
    expect(queueForSync).not.toHaveBeenCalled();
  });

  it('confirming removes the whole sup and queues delink + parent update', async () => {
    mountAfterSup();
    confirmDialog.mockResolvedValue(true);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);
    await flush();

    expect(document.querySelector('sup')).toBeNull();
    expect(document.getElementById('1').textContent).toBe('aaatail');
    expect(queueForSync).toHaveBeenCalledWith('footnotes', 'Fn3', 'delete', { book: 'bookX', footnoteId: 'Fn3' });
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update');
  });

  it('a plain <sup> without fn-count-id is NOT guarded (browser default proceeds)', () => {
    document.body.innerHTML = '<p id="1">aaa<sup>2</sup>tail</p>';
    const sup = document.querySelector('sup');
    cursorAt(sup.nextSibling, 0);

    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});

describe('supDeleteHandler — hypercite link deletion confirm', () => {
  function mountHypercite() {
    document.body.innerHTML =
      '<p id="1">text<a href="https://h/x#hypercite_abc" class="open-icon" id="hypercite_abc">↗</a></p>';
    const p = document.getElementById('1');
    cursorAt(p, 2);                                    // caret after the anchor (backspace onto it)
    return p;
  }

  it('declining the confirm keeps the anchor', async () => {
    mountHypercite();
    confirmDialog.mockResolvedValue(false);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);

    expect(e.preventDefault).toHaveBeenCalled();           // sync, before dialog settles
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith({ message: 'Delete hypercite citation link?', danger: true });
    expect(document.querySelector('a.open-icon')).not.toBeNull();
  });

  it('confirming removes the anchor', async () => {
    mountHypercite();
    confirmDialog.mockResolvedValue(true);
    const e = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e);
    await flush();

    expect(document.querySelector('a.open-icon')).toBeNull();
  });

  it('key-repeat while the dialog is open: one dialog, every event preventDefaulted', async () => {
    mountHypercite();
    let resolveDialog;
    confirmDialog.mockReturnValue(new Promise((r) => { resolveDialog = r; }));

    const e1 = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e1);
    const e2 = ev({ inputType: 'deleteContentBackward' });
    supDeleteHandler(e2);

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(e1.preventDefault).toHaveBeenCalled();
    expect(e2.preventDefault).toHaveBeenCalled();

    resolveDialog(false);                               // release the in-flight guard
    await flush();
    expect(document.querySelector('a.open-icon')).not.toBeNull();
  });
});
