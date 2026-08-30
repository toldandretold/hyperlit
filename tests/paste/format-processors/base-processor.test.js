/**
 * appendStaticSections must never emit a block nested inside its host <p>.
 *
 * A nested <p><p> survives in the DOM (fragment parsing in a `p` context does
 * not auto-close) until the next serialize -> reparse, which the pipeline does
 * twice — base-processor's linkCitations, then html-block-parser. Each reference
 * then lands in the node store as an EMPTY tagged <p>, an untagged <p> holding
 * the text, and a stray empty <p>. That is the book_1788040795553 report.
 */

import { describe, it, expect } from 'vitest';
import { BaseFormatProcessor } from '../../../resources/js/paste/format-processors/base-processor';
import { flattenForInlineHost } from '../../../resources/js/paste/utils/inline-fragment';

/** Serialize + reparse, exactly as base-processor.ts does after linking. */
function reparse(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('appendStaticSections', () => {
  it('never emits a nested <p><p> from a block-level reference payload', () => {
    const dom = document.createElement('div');
    new BaseFormatProcessor('test').appendStaticSections(dom, [], [
      { content: '<p>Smith, J. (2020). Title. Journal of Testing.</p>' },
    ]);

    expect(dom.innerHTML).not.toMatch(/<p[^>]*>\s*<p/i);

    const survived = reparse(dom.innerHTML);
    expect(survived.children).toHaveLength(2); // h2 + one entry, no empties
    expect(survived.children[1].getAttribute('data-static-content')).toBe('bibliography');
    expect(survived.children[1].textContent).toContain('Smith, J. (2020)');
  });

  it('keeps the number attached to a block-level footnote payload', () => {
    const dom = document.createElement('div');
    new BaseFormatProcessor('test').appendStaticSections(
      dom,
      [{ originalIdentifier: '1', content: '<p>Ibid., 14.</p>' }],
      [],
    );

    const survived = reparse(dom.innerHTML);
    expect(survived.children).toHaveLength(2); // h2 + one note
    expect(survived.children[1].getAttribute('data-static-content')).toBe('footnotes');
    expect(survived.children[1].textContent.trim()).toBe('1. Ibid., 14.');
  });

  it('does not double-number a block payload that already carries its number', () => {
    const dom = document.createElement('div');
    new BaseFormatProcessor('test').appendStaticSections(
      dom,
      [{ originalIdentifier: '1', content: '<p>1. Ibid., 14.</p>' }],
      [],
    );

    expect(reparse(dom.innerHTML).children[1].textContent.trim()).toBe('1. Ibid., 14.');
  });

  it('leaves inline payloads untouched', () => {
    const dom = document.createElement('div');
    new BaseFormatProcessor('test').appendStaticSections(dom, [], [
      { content: 'Smith, J. (2020). <em>Title</em>. Journal.' },
    ]);

    const survived = reparse(dom.innerHTML);
    expect(survived.children).toHaveLength(2);
    expect(survived.children[1].querySelector('em')).toBeTruthy();
  });
});

describe('flattenForInlineHost', () => {
  it('unwraps a sole block wrapper', () => {
    expect(flattenForInlineHost('<p>hello</p>')).toBe('hello');
    expect(flattenForInlineHost('<div><p>hello</p></div>')).toBe('hello');
  });

  it('joins several top-level blocks with <br> rather than losing them', () => {
    const out = flattenForInlineHost('<p>one</p><p>two</p>');
    expect(out).toBe('one<br>two');
    expect(reparse(`<p>${out}</p>`).children).toHaveLength(1);
  });

  it('is a no-op for inline and plain-text payloads', () => {
    expect(flattenForInlineHost('plain text')).toBe('plain text');
    expect(flattenForInlineHost('<em>emphasis</em> and text')).toBe('<em>emphasis</em> and text');
  });

  it('handles empty input', () => {
    expect(flattenForInlineHost('')).toBe('');
    expect(flattenForInlineHost(null)).toBe('');
  });
});
