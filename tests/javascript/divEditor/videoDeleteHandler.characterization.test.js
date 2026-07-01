/**
 * Characterization of createVideoDeleteHandler (divEditor/videoDeleteHandler.ts): the
 * click handler behind the per-node delete buttons on broken images and video embeds.
 * SaveQueue is a fake with spy'd queueDeletion/queueNode; nodeResolve + idHelpers are real
 * (zero-import leaves). resolveTopLevelNode walks UP from the wrapper, so the exercised
 * broken-image path is "image is part of a node" (whole-node delete vs content update).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVideoDeleteHandler } from '../../../resources/js/divEditor/videoDeleteHandler';

let saveQueue;
let editableDiv;
beforeEach(() => {
  document.body.innerHTML = '<div id="editable"><div class="chunk"></div></div>';
  editableDiv = document.getElementById('editable');
  saveQueue = { queueDeletion: vi.fn(), queueNode: vi.fn() };
});

function makeHandler() {
  return createVideoDeleteHandler({ editableDiv, bookId: 'testbook', getSaveQueue: () => saveQueue });
}
const clickOn = (btn) => ({ target: btn, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe('broken image', () => {
  it('image-only node → deletes the whole node and queues a deletion', () => {
    const chunk = editableDiv.querySelector('.chunk');
    chunk.innerHTML =
      '<figure id="5" data-node-id="b_1_x">' +
      '<span class="broken-image-wrapper"><img><button data-action="delete-broken-image">x</button></span>' +
      '</figure><p id="6">next</p>';
    const btn = chunk.querySelector('button');

    makeHandler()(clickOn(btn));

    expect(chunk.querySelector('figure')).toBeNull();               // node removed
    expect(saveQueue.queueDeletion).toHaveBeenCalledTimes(1);
    expect(saveQueue.queueDeletion.mock.calls[0][0]).toBe('5');     // lineId
    expect(saveQueue.queueNode).not.toHaveBeenCalled();
  });

  it('node with text + image → keeps the node and queues an update', () => {
    const chunk = editableDiv.querySelector('.chunk');
    chunk.innerHTML =
      '<figure id="7" data-node-id="b_1_y">Caption text' +
      '<span class="broken-image-wrapper"><img><button data-action="delete-broken-image">x</button></span>' +
      '</figure>';
    const btn = chunk.querySelector('button');

    makeHandler()(clickOn(btn));

    expect(chunk.querySelector('figure')).not.toBeNull();           // node survives
    expect(chunk.querySelector('img')).toBeNull();                  // image gone
    expect(saveQueue.queueNode).toHaveBeenCalledWith('7', 'update');
    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
  });
});

describe('video embed', () => {
  it('standalone video → replaced with a paragraph carrying its id', () => {
    const chunk = editableDiv.querySelector('.chunk');
    chunk.innerHTML = '<div class="video-embed" id="9"><button data-action="delete-video">x</button></div>';
    const btn = chunk.querySelector('button');

    makeHandler()(clickOn(btn));

    expect(chunk.querySelector('.video-embed')).toBeNull();
    const p = chunk.querySelector('p');
    expect(p).not.toBeNull();
    expect(p.id).toBe('9');
  });

  it('video with an adjacent block → removed, no replacement paragraph', () => {
    const chunk = editableDiv.querySelector('.chunk');
    chunk.innerHTML =
      '<div class="video-embed" id="9"><button data-action="delete-video">x</button></div>' +
      '<p id="10">after</p>';
    const btn = chunk.querySelector('button');

    makeHandler()(clickOn(btn));

    expect(chunk.querySelector('.video-embed')).toBeNull();
    expect(chunk.querySelectorAll('p').length).toBe(1);             // only the pre-existing block
    expect(document.getElementById('10')).not.toBeNull();
  });
});

describe('non-target click', () => {
  it('ignores clicks that miss a delete button', () => {
    const chunk = editableDiv.querySelector('.chunk');
    chunk.innerHTML = '<p id="1">hello</p>';
    const e = clickOn(chunk.querySelector('[id="1"]'));

    makeHandler()(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
    expect(saveQueue.queueNode).not.toHaveBeenCalled();
  });
});
