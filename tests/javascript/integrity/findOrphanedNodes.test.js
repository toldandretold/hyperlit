// @vitest-environment happy-dom
/**
 * findOrphanedNodes — orphan scan must not count render chrome as lost content.
 *
 * A markdown import referencing an unreachable image 404s at render;
 * lazyLoader/imageState wraps the <picture> in an id-less
 * <div class="broken-image-wrapper"> (delete button + layout guard) that
 * contentProcessor strips again on save. Counting that wrapper as an "orphaned
 * node" fired the full "data loss (our bad)" modal on every edit-exit of such a
 * book — with zero mismatches, zero missing, server fully consistent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findOrphanedNodes } from '../../../resources/js/integrity/verifier';

const BOOK = 'capital';

function buildChunk() {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = BOOK;
  const chunk = document.createElement('div');
  chunk.setAttribute('data-chunk-id', '0');
  container.appendChild(chunk);
  document.body.appendChild(container);
  return chunk;
}

describe('findOrphanedNodes', () => {
  let chunk;
  beforeEach(() => { chunk = buildChunk(); });

  it('skips the broken-image wrapper chrome (the md-import 404 false alarm)', () => {
    // Normal id-bearing node
    const p = document.createElement('p');
    p.id = '100';
    p.textContent = 'real content';
    chunk.appendChild(p);

    // What imageState.decorateBrokenImage produces around a 404'd image
    const wrapper = document.createElement('div');
    wrapper.className = 'broken-image-wrapper';
    wrapper.setAttribute('contenteditable', 'false');
    wrapper.innerHTML =
      '<picture id="200"><img class="broken-image" alt="Image failed to load"></picture>'
      + '<button class="broken-image-delete-btn"></button>';
    chunk.appendChild(wrapper);

    expect(findOrphanedNodes(BOOK)).toHaveLength(0);
  });

  it('still flags a genuinely orphaned id-less block', () => {
    const stray = document.createElement('div');
    stray.textContent = 'pasted content that never got an id';
    chunk.appendChild(stray);

    const orphans = findOrphanedNodes(BOOK);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].tag).toBe('DIV');
    expect(orphans[0].textSnippet).toContain('never got an id');
  });

  it('skips sentinels and elements with valid numeric ids', () => {
    const sentinel = document.createElement('div');
    sentinel.setAttribute('data-sentinel', 'top');
    chunk.appendChild(sentinel);

    const decimal = document.createElement('p');
    decimal.id = '100.5';
    decimal.textContent = 'decimal id node';
    chunk.appendChild(decimal);

    expect(findOrphanedNodes(BOOK)).toHaveLength(0);
  });
});
