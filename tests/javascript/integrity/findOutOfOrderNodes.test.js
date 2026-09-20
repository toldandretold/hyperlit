// @vitest-environment happy-dom
/**
 * findOutOfOrderNodes — the detector for the ONE integrity failure the per-node
 * DOM↔IDB comparison is structurally blind to.
 *
 * verifyNodesIntegrity looks up each rendered node's IDB record BY ID and compares text.
 * When a node is minted with an id that doesn't sort where it sits, every node still
 * matches its own record byte for byte — only the SEQUENCE is wrong — so the sweep comes
 * back clean and the book reads fine until the next render replays it in startLine order
 * (and the audiobook, built from the same records, narrates it in that order too).
 *
 * That is exactly how the 2026-09-18 list-escape reorder reached prod behind a green
 * integrity sweep. These tests pin the detector that closes it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findOutOfOrderNodes } from '../../../resources/js/integrity/verifier';

beforeEach(() => { document.body.innerHTML = ''; });

function chunk(html) {
  document.body.innerHTML = `<div data-book-id="bookA"><div class="chunk" data-chunk-id="1">${html}</div></div>`;
  return document.querySelector('[data-book-id="bookA"]');
}

describe('findOutOfOrderNodes', () => {
  it('is silent when DOM order matches id order', () => {
    const c = chunk('<p id="10">a</p><p id="20">b</p><p id="20.1">c</p><p id="30">d</p>');
    expect(findOutOfOrderNodes(c)).toEqual([]);
  });

  it('catches the list-escape reorder: a node sorting ~100 ids past where it sits', () => {
    // What the buggy middle-of-list split produced: paragraph 120 and list 220 sitting
    // between 20 and 30, so a reload would drag both of them to the end of the chunk.
    const c = chunk('<p id="10">a</p><ol id="20"><li>a</li></ol><p id="120">escaped</p><ol id="220"><li>c</li></ol><p id="30">d</p>');
    const found = findOutOfOrderNodes(c);
    expect(found.map((n) => n.id)).toEqual(['30']);
    expect(found[0].previousId).toBe('220');
    expect(found[0].tag).toBe('P');
  });

  it('catches a node minted BELOW the node it follows', () => {
    const c = chunk('<p id="10">a</p><ol id="20"><li>a</li></ol><blockquote id="15">lifted</blockquote><p id="30">d</p>');
    const found = findOutOfOrderNodes(c);
    expect(found.map((n) => n.id)).toEqual(['15']);
    expect(found[0].previousId).toBe('20');
  });

  // The verdict has to agree with what actually reorders the book: read.ts sorts
  // `a.startLine - b.startLine` over a startLine stored as a NUMBER. compareDecimalStrings
  // pads the shorter decimal with trailing zeros, which is that same ordering — so "100.9"
  // comes AFTER "100.10" (== 100.1), and a detector using raw string compare would call
  // that pair fine and miss a genuine reorder.
  it('orders decimals the way the renderer does', () => {
    for (const [a, b] of [['100.1', '100.2'], ['100.1', '100.11'], ['100.10', '100.9'], ['9', '10']]) {
      expect(findOutOfOrderNodes(chunk(`<p id="${a}">a</p><p id="${b}">b</p>`))).toEqual([]);
      expect(findOutOfOrderNodes(chunk(`<p id="${b}">b</p><p id="${a}">a</p>`)).map((n) => n.id)).toEqual([a]);
    }
  });

  it('flags two nodes claiming ONE position — including a trailing-zero alias', () => {
    // A repeated id is the blunt case; "100.1" then "100.10" is the same collision in
    // disguise, because both parse to the startLine 100.1 and share an IDB record key.
    expect(findOutOfOrderNodes(chunk('<p id="10">a</p><p id="20">b</p><p id="20">b again</p>')).map((n) => n.id)).toEqual(['20']);
    expect(findOutOfOrderNodes(chunk('<p id="100.1">a</p><p id="100.10">b</p>')).map((n) => n.id)).toEqual(['100.10']);
  });

  it('ignores non-numeric ids (footnote sups, render furniture)', () => {
    const c = chunk('<p id="10">a</p><div id="broken-image-3">x</div><p id="20">b</p>');
    expect(findOutOfOrderNodes(c)).toEqual([]);
  });

  it('scopes per chunk — each chunk is compared on its own, never across the boundary', () => {
    document.body.innerHTML = `
      <div data-book-id="bookA">
        <div class="chunk" data-chunk-id="1"><p id="10">a</p><p id="20">b</p></div>
        <div class="chunk" data-chunk-id="2"><p id="30">c</p><p id="40">d</p></div>
      </div>`;
    expect(findOutOfOrderNodes(document.querySelector('[data-book-id="bookA"]'))).toEqual([]);
  });

  it('does not compare a nested sub-book against its host (sub-book ids restart at 1)', () => {
    document.body.innerHTML = `
      <div data-book-id="bookA">
        <div class="chunk" data-chunk-id="1">
          <p id="10">a</p>
          <div class="sub-book-content" data-book-id="bookA/Fn1">
            <div class="chunk" data-chunk-id="1"><p id="1">note</p><p id="2">note 2</p></div>
          </div>
          <p id="20">b</p>
        </div>
      </div>`;
    expect(findOutOfOrderNodes(document.querySelector('[data-book-id="bookA"]'))).toEqual([]);
  });

  it('works on an unchunked container', () => {
    document.body.innerHTML = '<div data-book-id="bookA"><p id="10">a</p><p id="5">b</p></div>';
    expect(findOutOfOrderNodes(document.querySelector('[data-book-id="bookA"]')).map((n) => n.id)).toEqual(['5']);
  });

  it('returns [] for a missing container rather than throwing', () => {
    expect(findOutOfOrderNodes(null)).toEqual([]);
  });
});
