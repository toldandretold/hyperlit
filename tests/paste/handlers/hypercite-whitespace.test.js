/**
 * Regression test for the hypercite replace-paste whitespace bug.
 *
 * Bug: when the user selects a span of text (e.g. 'Commons-based peer production')
 * and pastes a hypercite as a replacement, the inserted fragment ends with </a>
 * and relies on the surviving text node retaining its leading space. On Safari
 * 26.4 the saved IDB content was observed to be missing that space — DOM had
 * `…↗</a> also fulfils` but IDB had `…↗</a>also fulfils`.
 *
 * The helper under test (`ensureSpaceAfterAnchor`) guarantees, immediately after
 * insertion, that the anchor is followed by whitespace (or trailing punctuation,
 * or end-of-block). This decouples correctness from browser-specific behaviour
 * of `range.deleteContents()` / `range.insertNode()`.
 */

import { describe, it, expect } from 'vitest';
import { ensureSpaceAfterAnchor } from '../../../resources/js/paste/utils/anchorSpacing.js';

function buildAnchor(doc = document) {
  const a = doc.createElement('a');
  a.setAttribute('href', '/bookA#hypercite_abc1234');
  a.setAttribute('id', 'hypercite_zzzz999');
  a.className = 'open-icon';
  a.textContent = '↗'; // ↗
  return a;
}

describe('ensureSpaceAfterAnchor — unit', () => {
  it('prepends a space when the next sibling text node starts with a letter', () => {
    const p = document.createElement('p');
    p.innerHTML = `prefix '⁠`;
    const a = buildAnchor();
    p.appendChild(a);
    p.appendChild(document.createTextNode('also fulfils predictions'));

    const changed = ensureSpaceAfterAnchor(a);

    expect(changed).toBe(true);
    expect(a.nextSibling.textContent).toBe(' also fulfils predictions');
  });

  it('is a no-op when the next sibling already starts with a space', () => {
    const p = document.createElement('p');
    const a = buildAnchor();
    p.appendChild(a);
    p.appendChild(document.createTextNode(' also fulfils predictions'));

    const changed = ensureSpaceAfterAnchor(a);

    expect(changed).toBe(false);
    expect(a.nextSibling.textContent).toBe(' also fulfils predictions');
  });

  it('is a no-op when the next sibling starts with sentence-ending punctuation', () => {
    const p = document.createElement('p');
    const a = buildAnchor();
    p.appendChild(a);
    p.appendChild(document.createTextNode('. The next sentence.'));

    const changed = ensureSpaceAfterAnchor(a);

    expect(changed).toBe(false);
    expect(a.nextSibling.textContent).toBe('. The next sentence.');
  });

  it('is a no-op when the anchor is the last child of its block', () => {
    const p = document.createElement('p');
    const a = buildAnchor();
    p.appendChild(a);

    const changed = ensureSpaceAfterAnchor(a);

    expect(changed).toBe(false);
    expect(a.nextSibling).toBeNull();
  });

  it('inserts a space text node when the next sibling is an element (not text)', () => {
    const p = document.createElement('p');
    const a = buildAnchor();
    const span = document.createElement('span');
    span.textContent = 'inline';
    p.appendChild(a);
    p.appendChild(span);

    const changed = ensureSpaceAfterAnchor(a);

    expect(changed).toBe(true);
    expect(a.nextSibling.nodeType).toBe(Node.TEXT_NODE);
    expect(a.nextSibling.textContent).toBe(' ');
    expect(a.nextSibling.nextSibling).toBe(span);
  });

  it('treats word-joiner / zero-width prefixes as adequate (no extra space)', () => {
    const p = document.createElement('p');
    const a = buildAnchor();
    p.appendChild(a);
    p.appendChild(document.createTextNode('⁠also'));

    const changed = ensureSpaceAfterAnchor(a);

    expect(changed).toBe(false);
    expect(a.nextSibling.textContent).toBe('⁠also');
  });

  it('handles a detached anchor without throwing', () => {
    const a = buildAnchor();
    expect(() => ensureSpaceAfterAnchor(a)).not.toThrow();
    expect(ensureSpaceAfterAnchor(a)).toBe(false);
  });
});

describe('ensureSpaceAfterAnchor — integration with deleteContents + insertNode', () => {
  /**
   * Reproduce the replace-paste flow: paragraph contains
   *   `Foo 'bar baz' qux end.`
   * the user selects `'bar baz'` (with surrounding quotes, NOT the trailing
   * space), then pastes a hypercite. The handler builds combinedHtml as
   *   `'bar baz'⁠<a class="open-icon">↗</a>`
   * and inserts via range.deleteContents() + range.insertNode(fragment).
   */
  function simulateReplacePaste({ simulateSafariStripsSpace }) {
    const p = document.createElement('p');
    p.id = '400';
    p.innerHTML = "Foo 'bar baz' qux end.";
    document.body.appendChild(p);

    const textNode = p.firstChild;
    const idx = textNode.textContent.indexOf("'bar baz'");
    const range = document.createRange();
    range.setStart(textNode, idx);
    range.setEnd(textNode, idx + "'bar baz'".length);

    const combinedHtml = `'bar baz'⁠<a href="/bookA#hypercite_abc" id="hypercite_new1" class="open-icon">↗</a>`;
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = combinedHtml;
    const fragment = document.createDocumentFragment();
    while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);

    range.deleteContents();
    range.insertNode(fragment);

    const anchor = p.querySelector('a.open-icon');

    if (simulateSafariStripsSpace) {
      // Deterministic stand-in for the observed Safari behaviour: the surviving
      // text node loses its leading space after deleteContents + insertNode.
      const next = anchor.nextSibling;
      if (next && next.nodeType === Node.TEXT_NODE && next.textContent.startsWith(' ')) {
        next.textContent = next.textContent.slice(1);
      }
    }

    return { p, anchor };
  }

  it('without the helper, simulating Safari, the space is lost', () => {
    const { p, anchor } = simulateReplacePaste({ simulateSafariStripsSpace: true });
    // Sanity check: this is the broken state we want the helper to fix.
    expect(anchor.nextSibling.textContent.startsWith(' ')).toBe(false);
    expect(p.textContent).toContain('↗qux'); // ↗qux — no space
    document.body.innerHTML = '';
  });

  it('with the helper, simulating Safari, the space is restored', () => {
    const { p, anchor } = simulateReplacePaste({ simulateSafariStripsSpace: true });
    ensureSpaceAfterAnchor(anchor);
    expect(anchor.nextSibling.textContent.startsWith(' ')).toBe(true);
    expect(p.textContent).toContain('↗ qux'); // ↗ qux — space restored
    expect(p.textContent).toBe("Foo 'bar baz'⁠↗ qux end.");
    document.body.innerHTML = '';
  });

  it('with the helper, on a well-behaved engine, the result is unchanged (idempotent)', () => {
    const { p, anchor } = simulateReplacePaste({ simulateSafariStripsSpace: false });
    const before = p.textContent;
    const changed = ensureSpaceAfterAnchor(anchor);
    expect(changed).toBe(false);
    expect(p.textContent).toBe(before);
    document.body.innerHTML = '';
  });
});
