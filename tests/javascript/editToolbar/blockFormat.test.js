/**
 * Unit tests for the extracted blockFormat/ command modules.
 *
 * Focused on the content-preserving wrap/unwrap transforms (blockquoteCodeFormat) — the
 * self-independent DOM transforms that are unit-testable without a live selection/execCommand.
 * The selection/execCommand-driven entry points (handleHeadingFormat, handleBlockquoteCodeFormat,
 * handleListFormat, …) and the multi-block merges (cursor/save tails) need a selection harness
 * and are covered by the grand-tour e2e + the behaviour-preserving extraction; deeper unit tests
 * for them are a follow-up.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _contentPreservingWrap,
  _contentPreservingUnwrap,
} from '../../../resources/js/editToolbar/blockFormat/blockquoteCodeFormat';

function mount(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

describe('blockFormat/blockquoteCodeFormat — content-preserving transforms', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  describe('_contentPreservingWrap', () => {
    it('wraps a <p> into a <blockquote>, appends <br>, preserves id + data-node-id', () => {
      const c = mount('<p id="n1" data-node-id="x9">hello <strong>world</strong></p>');
      const out = _contentPreservingWrap(null, c.querySelector('#n1'), 'blockquote');

      expect(out.tagName).toBe('BLOCKQUOTE');
      expect(out.id).toBe('n1');
      expect(out.getAttribute('data-node-id')).toBe('x9');
      expect(out.innerHTML).toBe('hello <strong>world</strong><br>');
      // replaced in place
      expect(c.querySelector('blockquote#n1')).toBe(out);
      expect(c.querySelector('p')).toBeNull();
    });

    it('wraps a <p> into a <pre><code>, preserving id', () => {
      const c = mount('<p id="n2">code text</p>');
      const out = _contentPreservingWrap(null, c.querySelector('#n2'), 'code');

      expect(out.tagName).toBe('PRE');
      expect(out.id).toBe('n2');
      expect(out.querySelector('code')).not.toBeNull();
      expect(out.querySelector('code').innerHTML).toBe('code text');
    });

    it('does not double-append <br> when content already ends with one', () => {
      const c = mount('<p id="n3">x<br></p>');
      const out = _contentPreservingWrap(null, c.querySelector('#n3'), 'blockquote');
      expect(out.innerHTML).toBe('x<br>');
    });
  });

  describe('_contentPreservingUnwrap', () => {
    it('unwraps a <blockquote> back to <p>, strips trailing <br>, preserves id', () => {
      const c = mount('<blockquote id="n1" data-node-id="x9">hello<br></blockquote>');
      const out = _contentPreservingUnwrap(null, c.querySelector('#n1'), 'blockquote');

      expect(out.tagName).toBe('P');
      expect(out.id).toBe('n1');
      expect(out.getAttribute('data-node-id')).toBe('x9');
      expect(out.innerHTML).toBe('hello');
      expect(c.querySelector('blockquote')).toBeNull();
    });

    it('unwraps a <pre><code> back to <p> using the code content', () => {
      const c = mount('<pre id="n2"><code>code text</code></pre>');
      const out = _contentPreservingUnwrap(null, c.querySelector('#n2'), 'code');
      expect(out.tagName).toBe('P');
      expect(out.innerHTML).toBe('code text');
    });

    it('falls back to &nbsp; for empty content', () => {
      const c = mount('<blockquote id="n4"></blockquote>');
      const out = _contentPreservingUnwrap(null, c.querySelector('#n4'), 'blockquote');
      expect(out.textContent.charCodeAt(0)).toBe(160); // non-breaking-space fallback
    });
  });

  describe('wrap → unwrap round-trip', () => {
    it('returns to an equivalent <p> preserving content, id, and data-node-id', () => {
      const c = mount('<p id="n5" data-node-id="zz">round <em>trip</em></p>');
      const bq = _contentPreservingWrap(null, c.querySelector('#n5'), 'blockquote');
      const p = _contentPreservingUnwrap(null, bq, 'blockquote');

      expect(p.tagName).toBe('P');
      expect(p.id).toBe('n5');
      expect(p.getAttribute('data-node-id')).toBe('zz');
      expect(p.innerHTML).toBe('round <em>trip</em>');
    });
  });
});
