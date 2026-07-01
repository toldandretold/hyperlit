/**
 * Characterization of handleNoDeleteGuard (divEditor/keydownGuards/noDeleteGuard.ts):
 * the transfer-vs-refuse decision for the `no-delete-id` protected node. This is the
 * logic behind the "🛑 Refusing deletion" bug — the marker must MOVE to a genuinely
 * different node (excludeNode) so the protected node can still be deleted; only the
 * true last node is refused. Uses the REAL domUtilities marker helpers (no mock) so
 * the transfer is exercised end-to-end on the DOM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleNoDeleteGuard } from '../../../resources/js/divEditor/keydownGuards/noDeleteGuard';

beforeEach(() => { document.body.innerHTML = ''; });

function selectAllOf(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

describe('handleNoDeleteGuard', () => {
  it('returns false for a node without the marker (not protected)', () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk"><p id="1">hello</p></div></div>';
    const p = document.querySelector('[id="1"]');
    const range = selectAllOf(p);
    expect(handleNoDeleteGuard(range, p)).toBe(false);
  });

  it('transfers the marker to the next node and returns false when siblings exist', () => {
    // Marker sits on the FIRST node (id 100) — the exact case that used to wrongly refuse.
    document.body.innerHTML =
      '<div class="main-content"><div class="chunk">' +
      '<h1 id="100" no-delete-id="please">Title</h1><p id="101">body</p>' +
      '</div></div>';
    const title = document.querySelector('[id="100"]');
    const body = document.querySelector('[id="101"]');
    const range = selectAllOf(title);

    const result = handleNoDeleteGuard(range, title);

    expect(result).toBe(false);                                   // deletion allowed to proceed
    expect(title.hasAttribute('no-delete-id')).toBe(false);       // marker left the title
    expect(body.getAttribute('no-delete-id')).toBe('please');     // ...and moved to the next node
  });

  it('returns true (refuse) when the protected node is the only content node', () => {
    document.body.innerHTML =
      '<div class="main-content"><div class="chunk">' +
      '<p id="1" no-delete-id="please">only</p>' +
      '</div></div>';
    const only = document.querySelector('[id="1"]');
    const range = selectAllOf(only);

    expect(handleNoDeleteGuard(range, only)).toBe(true);          // caller must preventDefault
    expect(only.getAttribute('no-delete-id')).toBe('please');     // marker stays put
  });

  it('returns false when the selection would NOT clear the whole node', () => {
    document.body.innerHTML =
      '<div class="main-content"><div class="chunk">' +
      '<p id="1" no-delete-id="please">hello world</p><p id="2">next</p>' +
      '</div></div>';
    const p = document.querySelector('[id="1"]');
    // Collapsed caret in the middle — not a full clear.
    const r = document.createRange();
    r.setStart(p.firstChild, 3);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    expect(handleNoDeleteGuard(r, p)).toBe(false);
    expect(p.getAttribute('no-delete-id')).toBe('please');        // untouched — no full clear
  });
});
