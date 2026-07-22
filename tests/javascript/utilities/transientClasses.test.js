/**
 * @vitest-environment jsdom
 *
 * Unit tests for stripTransientNodeClasses — the single source of truth that
 * keeps render-only node-ROOT classes (audio-reading / cascade-origin) out of
 * persisted content. Consumed by BOTH the save path (contentProcessor) and the
 * render path (chunkRender), so it must handle the class on the root element
 * itself AND on descendants, and clean up empty class attributes.
 */

import { describe, it, expect } from 'vitest';
import {
  TRANSIENT_NODE_CLASSES,
  stripTransientNodeClasses,
} from '../../../resources/js/utilities/transientClasses';

/** Build a <p> node from an HTML string, optionally with a class on the root. */
function makeNode(innerHTML, rootClass) {
  const p = document.createElement('p');
  p.id = '8000';
  p.setAttribute('data-node-id', 'book_test_node1');
  if (rootClass) p.setAttribute('class', rootClass);
  p.innerHTML = innerHTML;
  return p;
}

describe('stripTransientNodeClasses', () => {
  it('lists audio-reading and cascade-origin as transient', () => {
    expect(TRANSIENT_NODE_CLASSES).toContain('audio-reading');
    expect(TRANSIENT_NODE_CLASSES).toContain('cascade-origin');
  });

  it('removes a transient class from the ROOT element (the reported bug)', () => {
    const node = makeNode('Some paragraph text.', 'audio-reading');
    const changed = stripTransientNodeClasses(node);

    expect(changed).toBe(true);
    expect(node.classList.contains('audio-reading')).toBe(false);
    // Only class was transient → the empty class attribute is dropped entirely.
    expect(node.hasAttribute('class')).toBe(false);
  });

  it('keeps a real class on the root while removing the transient token', () => {
    const node = makeNode('Some paragraph text.', 'foo audio-reading bar');
    const changed = stripTransientNodeClasses(node);

    expect(changed).toBe(true);
    expect(node.getAttribute('class')).toBe('foo bar');
  });

  it('removes a transient class from a DESCENDANT element (span survives)', () => {
    const node = makeNode('A <span class="cascade-origin">nested</span> span.');
    const changed = stripTransientNodeClasses(node);

    expect(changed).toBe(true);
    const span = node.querySelector('span');
    expect(span).not.toBeNull();
    expect(span.classList.contains('cascade-origin')).toBe(false);
    expect(span.hasAttribute('class')).toBe(false); // empty class attr dropped
    expect(span.textContent).toBe('nested');
  });

  it('returns false and mutates nothing when no transient class is present', () => {
    const node = makeNode('A <a class="citation-ref" id="Ref1">cite</a>.', 'keep-me');
    const before = node.outerHTML;
    const changed = stripTransientNodeClasses(node);

    expect(changed).toBe(false);
    expect(node.outerHTML).toBe(before);
  });

  it('strips both root and descendant transient classes in one pass', () => {
    const node = makeNode(
      'X <u id="hypercite_1" class="cascade-origin">cite</u> Y',
      'audio-reading',
    );
    const changed = stripTransientNodeClasses(node);

    expect(changed).toBe(true);
    expect(node.hasAttribute('class')).toBe(false);
    const u = node.querySelector('u');
    expect(u.classList.contains('cascade-origin')).toBe(false);
    // The <u>'s id survives; only its now-empty class attribute is removed.
    expect(u.getAttribute('id')).toBe('hypercite_1');
    expect(u.hasAttribute('class')).toBe(false);
  });
});
