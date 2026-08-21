/**
 * @vitest-environment jsdom
 *
 * MUST run under jsdom: the point of these tests is the HTML *parser* rule that
 * happy-dom does not implement — a "li" start tag CLOSES an open <p>.
 *
 * Render-side repair for nodes stored as `<p …><li>…</li></p>`.
 *
 * That shape is invalid HTML, so the stored string does not survive a parse: the
 * <p> closes at the first <li> and the node renders EMPTY while the list items
 * become loose siblings. The next save then persists the emptiness — silent text
 * loss. A small paste that split a bullet list used to write exactly this
 * (prod report book_1787277324949, 2026-08-21: "DOM 49 chars, IDB 0 chars"), so
 * damaged records exist and must be repaired on the way to the screen.
 */
import { describe, it, expect } from 'vitest';
import { repairListNodeContent, renderBlockToHtml } from '../../../resources/js/utilities/convertMarkdown';

/** What the browser actually keeps when the stored string is parsed. */
function parseRoot(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.firstElementChild;
}

// The record as it was written to IndexedDB in the prod report.
const DAMAGED =
  '<p id="191.1" data-node-id="book_1787277324949_1787278947469_d63jndf0t">' +
  '<li></li><li>​equipped with an in-text open weight AI Archivist&nbsp;</li></p>';

describe('repairListNodeContent', () => {
  it('the damaged shape really does lose its text on a parse (the bug)', () => {
    const root = parseRoot(DAMAGED);
    expect(root.tagName).toBe('P');
    expect(root.textContent.trim()).toBe(''); // ← the "IDB 0 chars" report
  });

  it('repairs the wrapper to a <ul> so the text survives the parse', () => {
    const root = parseRoot(repairListNodeContent(DAMAGED));

    expect(root.tagName).toBe('UL');
    expect(root.textContent).toContain('equipped with an in-text open weight AI Archivist');
  });

  it('keeps the node identity (id + data-node-id) intact', () => {
    const root = parseRoot(repairListNodeContent(DAMAGED));

    expect(root.id).toBe('191.1');
    expect(root.getAttribute('data-node-id')).toBe('book_1787277324949_1787278947469_d63jndf0t');
    expect(root.querySelectorAll('li')).toHaveLength(2);
  });

  it('repairs the same shape under other text wrappers', () => {
    for (const tag of ['h2', 'blockquote', 'div']) {
      const root = parseRoot(repairListNodeContent(`<${tag} id="7"><li>kept</li></${tag}>`));
      expect(root.tagName).toBe('UL');
      expect(root.textContent).toBe('kept');
    }
  });

  it('leaves healthy content untouched', () => {
    const healthy = [
      '<p id="5" data-node-id="n5">just a paragraph</p>',
      '<ul id="6" data-node-id="n6"><li>a real list</li></ul>',
      '<ol id="7"><li>ordered</li></ol>',
      '<p id="8">text with a <strong>bold</strong> bit</p>',
      '',
    ];
    for (const content of healthy) {
      expect(repairListNodeContent(content)).toBe(content);
    }
  });

  it('leaves mixed content alone rather than guessing', () => {
    // Not the shape the paste bug produced — repairing it would reorder the text.
    const mixed = '<p id="9">leading text<li>item</li></p>';
    expect(repairListNodeContent(mixed)).toBe(mixed);
  });

  it('is applied by renderBlockToHtml (the chunk render path)', () => {
    const html = renderBlockToHtml({ startLine: '191.1', content: DAMAGED });
    expect(parseRoot(html).textContent).toContain('equipped with an in-text');
  });
});
