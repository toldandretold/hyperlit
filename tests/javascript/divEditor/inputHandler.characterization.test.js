/**
 * Characterization of createInputHandler (divEditor/inputHandler.ts): the debounced text
 * input pipeline. Asserts it queues the resolved numeric-parent node on input, records the
 * input event on the SaveQueue, gates on isEditing/isComposing, flush() forces the debounce,
 * and destroy() detaches all three listeners (the composition-leak fix). Collaborators are
 * mocked; fake timers drive the 200ms debounce deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave, queueNodeForDeletion: vi.fn() }));
vi.mock('../../../resources/js/components/tocContainer/index', () => ({ checkAndInvalidateTocCache: vi.fn() }));
vi.mock('../../../resources/js/utilities/stripInlineStyle', () => ({ stripInlineStylePreservingIntensity: vi.fn() }));
// Real idHelpers/blockElements/debounce are leaves — use them.

import { createInputHandler } from '../../../resources/js/divEditor/inputHandler';

let editableDiv;
let saveQueue;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="editable" contenteditable="true"><p id="5">hello</p></div>';
  editableDiv = document.getElementById('editable');
  saveQueue = { recordInputEvent: vi.fn() };
  window.isEditing = true;
  vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

function caretIn(node, offset = 0) {
  const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}

describe('createInputHandler', () => {
  it('queues the numeric-parent node for update after the debounce, and records the input', () => {
    const handler = createInputHandler({ editableDiv, getSaveQueue: () => saveQueue });
    const p = document.getElementById('5');
    caretIn(p.firstChild, 2);

    editableDiv.dispatchEvent(new Event('input'));
    expect(saveQueue.recordInputEvent).toHaveBeenCalled();   // eager wrapper fired synchronously
    expect(queueNodeForSave).not.toHaveBeenCalled();          // debounce hasn't fired yet

    vi.advanceTimersByTime(200);
    expect(queueNodeForSave).toHaveBeenCalledWith('5', 'update');
    handler.destroy();
  });

  it('does not process input while not editing', () => {
    const handler = createInputHandler({ editableDiv, getSaveQueue: () => saveQueue });
    window.isEditing = false;
    caretIn(document.getElementById('5').firstChild, 1);

    editableDiv.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);

    expect(queueNodeForSave).not.toHaveBeenCalled();
    expect(saveQueue.recordInputEvent).not.toHaveBeenCalled();
    handler.destroy();
  });

  it('pauses during IME composition and resumes on compositionend', () => {
    const handler = createInputHandler({ editableDiv, getSaveQueue: () => saveQueue });
    caretIn(document.getElementById('5').firstChild, 1);

    editableDiv.dispatchEvent(new Event('compositionstart'));
    editableDiv.dispatchEvent(new Event('input'));           // ignored — composing
    vi.advanceTimersByTime(200);
    expect(queueNodeForSave).not.toHaveBeenCalled();

    editableDiv.dispatchEvent(new Event('compositionend'));  // resumes + re-fires the debounce
    vi.advanceTimersByTime(200);
    expect(queueNodeForSave).toHaveBeenCalledWith('5', 'update');
    handler.destroy();
  });

  it('flush() forces a pending debounce to run immediately', () => {
    const handler = createInputHandler({ editableDiv, getSaveQueue: () => saveQueue });
    caretIn(document.getElementById('5').firstChild, 1);

    editableDiv.dispatchEvent(new Event('input'));
    handler.flush();
    expect(queueNodeForSave).toHaveBeenCalledWith('5', 'update');
    handler.destroy();
  });

  it('destroy() detaches the listeners so later input is ignored', () => {
    const handler = createInputHandler({ editableDiv, getSaveQueue: () => saveQueue });
    handler.destroy();
    vi.clearAllMocks();

    caretIn(document.getElementById('5').firstChild, 1);
    editableDiv.dispatchEvent(new Event('input'));
    editableDiv.dispatchEvent(new Event('compositionstart'));
    editableDiv.dispatchEvent(new Event('compositionend'));
    vi.advanceTimersByTime(200);

    expect(saveQueue.recordInputEvent).not.toHaveBeenCalled();
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });
});
