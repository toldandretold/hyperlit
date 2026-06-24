/**
 * findRenderedTarget — the deep-link FLASH guard. When the target element is already rendered in the
 * container (e.g. a server-prerendered + adopted chunk), navigateToInternalId scrolls straight to it
 * instead of clearing <main> and re-rendering the chunk. This pins the selector logic (hypercite `<u>`
 * incl. overlapping, highlight `<mark>`, footnote/node by id) that decides "already rendered → no clear".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findRenderedTarget } from '../../../resources/js/scrolling/internalNav';

let container;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('findRenderedTarget', () => {
  it('finds a hypercite by id', () => {
    container.innerHTML = '<div class="chunk" data-chunk-id="200"><u id="hypercite_X" class="couple">Controller</u></div>';
    expect(findRenderedTarget(container, 'hypercite_X')?.id).toBe('hypercite_X');
  });

  it('finds a hypercite inside an OVERLAPPING segment via data-overlapping', () => {
    container.innerHTML = '<u id="hypercite_overlapping_1_2" data-overlapping="hypercite_A,hypercite_B">x</u>';
    const el = findRenderedTarget(container, 'hypercite_B');
    expect(el?.getAttribute('data-overlapping')).toBe('hypercite_A,hypercite_B');
  });

  it('finds a highlight by id and by class (overlap marks use a shared id)', () => {
    container.innerHTML = '<mark id="HL_overlap" class="HL_1 HL_2">t</mark>';
    expect(findRenderedTarget(container, 'HL_1')?.classList.contains('HL_1')).toBe(true); // by class
    container.innerHTML = '<mark id="HL_solo" class="HL_solo">t</mark>';
    expect(findRenderedTarget(container, 'HL_solo')?.id).toBe('HL_solo');                 // by id
  });

  it('finds a footnote / node element by id', () => {
    container.innerHTML = '<sup id="book_Fn1" fn-count-id="book_Fn1">1</sup>';
    expect(findRenderedTarget(container, 'book_Fn1')?.id).toBe('book_Fn1');
  });

  it('returns null when the target is NOT rendered (→ navigation falls back to clear+reload)', () => {
    container.innerHTML = '<div class="chunk" data-chunk-id="0"><p id="0">Top of book</p></div>';
    expect(findRenderedTarget(container, 'hypercite_X')).toBeNull();
    expect(findRenderedTarget(container, 'HL_9')).toBeNull();
    expect(findRenderedTarget(null, 'hypercite_X')).toBeNull();
    expect(findRenderedTarget(container, '')).toBeNull();
  });
});
