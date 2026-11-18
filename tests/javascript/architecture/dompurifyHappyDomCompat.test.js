/**
 * GATE: DOMPurify must round-trip legitimate markup under the test DOM.
 *
 * From 3.4.8 DOMPurify reads nodeName through a getter cached from
 * Node.prototype. happy-dom overrides that getter per subclass and its base
 * returns '', so without the shim in tests/javascript/setup/test-setup.js the
 * sanitizer strips EVERY element and only the text survives. That shipped as
 * three failures in overlapClick.characterization.test.js that read like a
 * highlight bug; this test names the real cause the moment either library moves.
 * Real browsers and jsdom are unaffected — see the shim's comment.
 */
import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import { sanitizeHtml } from '../../../resources/js/utilities/sanitizeConfig';

describe('DOMPurify under the vitest DOM', () => {
  it('reads every node kind by its real name through the Node.prototype getter', () => {
    // The invariant DOMPurify relies on: the getter cached from Node.prototype
    // answers the same as reading `.nodeName` off the instance, for every kind.
    // (happy-dom natively returns '' for a DocumentFragment either way — its own
    // bug, not the shim's — so compare against the instance rather than a literal.)
    const getter = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName').get;
    const kinds = [
      document.createElement('p'),
      document.createElement('mark'),
      document.createTextNode('x'),
      document.createComment('c'),
      document,
      document.createDocumentFragment(),
    ];
    for (const n of kinds) expect(getter.call(n)).toBe(n.nodeName);
    expect(getter.call(kinds[0])).toBe('P');
    expect(getter.call(kinds[2])).toBe('#text');
  });

  it('keeps a plain paragraph with id and data attributes intact (default config)', () => {
    expect(DOMPurify.sanitize('<p id="100" data-node-id="n-100">x</p>'))
      .toBe('<p id="100" data-node-id="n-100">x</p>');
  });

  it('keeps the app wrapper + mark structure through sanitizeHtml', () => {
    const html = '<p id="100" data-node-id="n-100"><mark id="HL_a" class="HL_a">aaa</mark>bbb</p>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('still strips what it must (control: the gate is not "keep everything")', () => {
    expect(sanitizeHtml('<p>x<script>alert(1)</script></p>')).toBe('<p>x</p>');
    expect(sanitizeHtml('<p onclick="alert(1)">x</p>')).toBe('<p>x</p>');
  });
});
