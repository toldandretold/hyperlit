/**
 * lastNodeGuard — the runtime "book can never end up with zero nodes"
 * invariant (replacement for the retired no-delete-id marker system).
 *
 * Contract under test (pure function, Range + Element in, boolean out —
 * `true` means the caller preventDefaults):
 *  - siblings exist → false (normal deletion proceeds)
 *  - last content node + full-clear edit → true, and the node has ALREADY
 *    been emptied in place (<br> body, caret seated inside) — "delete
 *    everything" visibly works but the node element survives
 *  - mid-node edits and partial selections → false (unguarded)
 *  - scoping is PER BOOK: a sub-book's last node is guarded even though the
 *    main book has plenty of nodes, and main-book counting ignores sub-books
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { handleLastNodeGuard } from '../../../resources/js/divEditor/keydownGuards/lastNodeGuard.js';

beforeEach(() => { document.body.innerHTML = ''; });

function selectAllOf(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

function caretIn(el, offset = 0) {
  const r = document.createRange();
  r.setStart(el.firstChild ?? el, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

function buildMain(nodesHtml) {
  document.body.innerHTML =
    `<div class="main-content"><div class="chunk" data-chunk-id="0">${nodesHtml}</div></div>`;
  return document.querySelector('.main-content');
}

describe('lastNodeGuard', () => {
  it('allows deletion when sibling content nodes exist', () => {
    buildMain('<p id="1">first</p><p id="2">second</p>');
    const p = document.getElementById('1');
    expect(handleLastNodeGuard(selectAllOf(p), p)).toBe(false);
    expect(p.textContent).toBe('first'); // untouched
  });

  it('refuses a select-all delete on the last node — clears content, keeps the element', () => {
    buildMain('<p id="1">only content</p>');
    const p = document.getElementById('1');
    expect(handleLastNodeGuard(selectAllOf(p), p)).toBe(true);
    expect(document.getElementById('1')).toBe(p);      // element survives
    expect(p.innerHTML).toBe('<br>');                  // content cleared
    // caret seated inside the node
    const sel = window.getSelection();
    expect(sel.rangeCount).toBeGreaterThan(0);
    expect(p.contains(sel.getRangeAt(0).startContainer)).toBe(true);
  });

  it('refuses backspace-at-start on an already-empty last node (repeat presses stay safe)', () => {
    buildMain('<p id="1"><br></p>');
    const p = document.getElementById('1');
    expect(handleLastNodeGuard(caretIn(p), p)).toBe(true);
    expect(document.getElementById('1')).toBe(p);
    // pressing again is still guarded — the book can never lose its node
    expect(handleLastNodeGuard(caretIn(p), p)).toBe(true);
  });

  it('ignores mid-node backspacing on the last node', () => {
    buildMain('<p id="1">hello world</p>');
    const p = document.getElementById('1');
    expect(handleLastNodeGuard(caretIn(p, 5), p)).toBe(false);
    expect(p.textContent).toBe('hello world');
  });

  it('ignores a partial selection on the last node', () => {
    buildMain('<p id="1">hello world</p>');
    const p = document.getElementById('1');
    const r = document.createRange();
    r.setStart(p.firstChild, 0);
    r.setEnd(p.firstChild, 5); // "hello" only
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    expect(handleLastNodeGuard(r, p)).toBe(false);
    expect(p.textContent).toBe('hello world');
  });

  it('ignores non-content targets (sentinels, non-numeric ids)', () => {
    buildMain('<p id="1">only</p>');
    document.querySelector('.chunk').insertAdjacentHTML('beforeend', '<div id="b-bottom-sentinel"></div><u id="hypercite_x">cite</u>');
    const sentinel = document.getElementById('b-bottom-sentinel');
    const cite = document.getElementById('hypercite_x');
    expect(handleLastNodeGuard(selectAllOf(sentinel), sentinel)).toBe(false);
    expect(handleLastNodeGuard(selectAllOf(cite), cite)).toBe(false);
  });

  it("guards a sub-book's last node even though the main book has nodes", () => {
    document.body.innerHTML =
      '<div class="main-content"><div class="chunk" data-chunk-id="0"><p id="1">main a</p><p id="2">main b</p></div></div>' +
      '<div class="sub-book-content" data-book-id="book_1/Fn_x"><div class="chunk" data-chunk-id="0"><p id="1">sub only</p></div></div>';
    const subP = document.querySelector('.sub-book-content p');
    expect(handleLastNodeGuard(selectAllOf(subP), subP)).toBe(true);
    expect(subP.innerHTML).toBe('<br>');
    // the main book's nodes are untouched
    expect(document.querySelector('.main-content p').textContent).toBe('main a');
  });

  it("main-book counting ignores sub-book nodes: main's last node is guarded despite a populated sub-book", () => {
    document.body.innerHTML =
      '<div class="main-content"><div class="chunk" data-chunk-id="0"><p id="1">main only</p>' +
      '<div class="sub-book-content" data-book-id="book_1/Fn_x"><div class="chunk" data-chunk-id="0"><p id="1">sub a</p><p id="2">sub b</p></div></div>' +
      '</div></div>';
    const mainP = document.querySelector('.main-content > .chunk > p');
    expect(handleLastNodeGuard(selectAllOf(mainP), mainP)).toBe(true);
    expect(mainP.innerHTML).toBe('<br>');
  });
});
