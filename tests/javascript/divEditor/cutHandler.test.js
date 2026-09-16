/**
 * Cut-gesture hypercite protection (resources/js/divEditor/cutHandler.ts):
 * synchronous snapshot of hypercite elements in the selection before the
 * browser mutates the DOM, then a post-move-window finalize that delinks
 * absent citing anchors and tombstones+ghosts absent cited sources.
 *
 * The 60ms finalize delay (just past handleHyperciteRemoval's 50ms verify
 * window) is part of the behaviour, so the end-to-end block drives it with
 * fake timers rather than sleeping against a wall clock — see the note there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: vi.fn(async () => ({})) }));
vi.mock('../../../resources/js/hypercites/database', () => ({ getHyperciteById: vi.fn() }));
vi.mock('../../../resources/js/hypercites/deletion', () => ({
  delinkHypercite: vi.fn(async () => {}),
  markHyperciteAsGhost: vi.fn(async () => true),
}));

import { snapshotCutSelection, finalizeCut, handleCutEvent } from '../../../resources/js/divEditor/cutHandler';
import { queueNodeForSave } from '../../../resources/js/divEditor/editorState';
import { getHyperciteById } from '../../../resources/js/hypercites/database';
import { delinkHypercite, markHyperciteAsGhost } from '../../../resources/js/hypercites/deletion';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
});

function buildEditor() {
  document.body.innerHTML =
    '<div class="main-content"><div class="chunk" data-chunk-id="1">'
    + '<p id="100">aaa <u id="hypercite_s1" class="couple">cited text</u> bbb</p>'
    + '<p id="101">ccc ‘quote’<a id="hypercite_c1" href="/booka#hypercite_s9" class="open-icon">↗</a> ddd</p>'
    + '</div></div>';
}

function selectAcrossBothParagraphs() {
  const range = document.createRange();
  range.setStartBefore(document.getElementById('100').firstChild);
  range.setEndAfter(document.getElementById('101').lastChild);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

describe('snapshotCutSelection', () => {
  it('captures source u ids, anchor id+href, and the host block across a multi-node selection', () => {
    buildEditor();
    selectAcrossBothParagraphs();

    const snapshot = snapshotCutSelection();

    expect(snapshot).not.toBeNull();
    expect(snapshot.sourceUIds).toEqual(['hypercite_s1']);
    expect(snapshot.anchors).toEqual([{ elementId: 'hypercite_c1', href: '/booka#hypercite_s9' }]);
    expect(snapshot.hostBlockId).toBe('100');
  });

  it('returns null for a collapsed selection or one without hypercite elements', () => {
    buildEditor();
    expect(snapshotCutSelection()).toBeNull();

    const range = document.createRange();
    const plain = document.getElementById('101').firstChild; // "ccc 'quote'" text
    range.setStart(plain, 0);
    range.setEnd(plain, 3);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    expect(snapshotCutSelection()).toBeNull();
  });

  it('falls back to the href-derived id when the anchor has no id attribute', () => {
    buildEditor();
    document.getElementById('hypercite_c1').removeAttribute('id');
    selectAcrossBothParagraphs();

    const snapshot = snapshotCutSelection();

    expect(snapshot.anchors).toEqual([{ elementId: 'hypercite_s9', href: '/booka#hypercite_s9' }]);
  });
});

describe('finalizeCut', () => {
  it('delinks an anchor that is gone from the DOM', async () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk"><p id="100">left over</p></div></div>';

    await finalizeCut({
      sourceUIds: [],
      anchors: [{ elementId: 'hypercite_c1', href: '/booka#hypercite_s9' }],
      hostBlockId: null,
      takenAt: 0,
    });

    expect(delinkHypercite).toHaveBeenCalledWith('hypercite_c1', '/booka#hypercite_s9');
  });

  it('skips an anchor that is still (or again) in the DOM — cancelled cut / instant paste-back', async () => {
    buildEditor();

    await finalizeCut({
      sourceUIds: [],
      anchors: [{ elementId: 'hypercite_c1', href: '/booka#hypercite_s9' }],
      hostBlockId: null,
      takenAt: 0,
    });

    expect(delinkHypercite).not.toHaveBeenCalled();
  });

  it('tombstones + ghosts a CITED source u that is gone, and queues the host block', async () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk"><p id="100">left over</p></div></div>';
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_s1', citedIN: ['/bookb#hypercite_c1'] });

    await finalizeCut({ sourceUIds: ['hypercite_s1'], anchors: [], hostBlockId: '100', takenAt: 0 });

    const tombstone = document.getElementById('hypercite_s1');
    expect(tombstone).not.toBeNull();
    expect(tombstone.classList.contains('hypercite-tombstone')).toBe(true);
    expect(tombstone.getAttribute('data-ghost')).toBe('true');
    expect(tombstone.parentElement.id).toBe('100');
    expect(markHyperciteAsGhost).toHaveBeenCalledWith('hypercite_s1');
    expect(queueNodeForSave).toHaveBeenCalledWith('100', 'update');
  });

  it('does NOT tombstone an uncited source (left to the save-time reconciler)', async () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk"><p id="100">left over</p></div></div>';
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_s1', citedIN: [] });

    await finalizeCut({ sourceUIds: ['hypercite_s1'], anchors: [], hostBlockId: '100', takenAt: 0 });

    expect(document.getElementById('hypercite_s1')).toBeNull();
    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
  });

  it('skips a source u still in the DOM and one with no record', async () => {
    buildEditor();
    getHyperciteById.mockResolvedValue(undefined);

    await finalizeCut({ sourceUIds: ['hypercite_s1', 'hypercite_missing'], anchors: [], hostBlockId: '100', takenAt: 0 });

    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
    expect(document.getElementById('hypercite_s1').classList.contains('couple')).toBe(true);
  });
});

/**
 * Real timers (the 60ms finalize delay IS the behaviour under test), but these
 * two wait on the CONDITION rather than on a fixed sleep. They used to sleep a
 * flat 120ms against that 60ms delay — 60ms of slack, which the full suite's
 * parallel workers can eat, so the assertions ran before finalizeCut's awaited
 * promises had settled and the run went red at random while passing in
 * isolation. Polling can only be slower under load, never wrong; the negative
 * case still burns a full settle window before asserting nothing happened.
 *
 * (Fake timers are NOT the fix here — finalizeCut's own await chain doesn't
 * unwind under advanceTimersByTimeAsync, which silently inverts both results.)
 */
async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

describe('handleCutEvent (end-to-end timing)', () => {
  it('delinks after the finalize delay when the cut element stays gone', async () => {
    buildEditor();
    selectAcrossBothParagraphs();

    handleCutEvent();
    // Simulate the browser applying the cut right after the event.
    document.getElementById('hypercite_c1').remove();
    document.getElementById('hypercite_s1').remove();
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_s1', citedIN: ['/bookb#x'] });

    await waitFor(() => delinkHypercite.mock.calls.length > 0);

    expect(delinkHypercite).toHaveBeenCalledWith('hypercite_c1', '/booka#hypercite_s9');
    await waitFor(() => document.getElementById('hypercite_s1')?.classList.contains('hypercite-tombstone'));
    expect(document.getElementById('hypercite_s1')?.classList.contains('hypercite-tombstone')).toBe(true);
  });

  it('does nothing when the element is re-inserted before the finalize window closes', async () => {
    buildEditor();
    selectAcrossBothParagraphs();

    handleCutEvent();
    const anchor = document.getElementById('hypercite_c1');
    const parent = anchor.parentElement;
    anchor.remove();
    setTimeout(() => parent.appendChild(anchor), 10); // pasted back within the window

    // Negative case: nothing to poll FOR, so give the finalize a generous
    // window to misfire in before asserting it didn't.
    await new Promise((r) => setTimeout(r, 300));

    expect(delinkHypercite).not.toHaveBeenCalled();
  });
});
