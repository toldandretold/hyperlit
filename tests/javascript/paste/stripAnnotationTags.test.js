/**
 * Pins that pasted annotation markup is unwrapped, not baked into node content.
 *
 * `<mark>` (highlight) and `<u>` (hypercite) are RENDER-TIME wrappers applied over
 * a node's stored plain content — never part of it. When app text carrying those
 * decorations is copied and pasted elsewhere, the wrapper markup rides along in the
 * clipboard HTML. Left in, it bakes a dead highlight/hypercite underline (plus stale
 * cross-book data-overlapping / data-hypercite-listener attributes) into this book's
 * node. Both must be unwrapped to their text on paste. Regression: a copied hypercite
 * `<u data-overlapping="…" data-hypercite-listener="true">` survived a small paste.
 */
import { describe, it, expect } from 'vitest';
import { stripMarkTags, stripHyperciteTags } from '../../../resources/js/paste/utils/normalizer';

describe('stripHyperciteTags', () => {
  it('unwraps a hypercite <u>, keeping its text', () => {
    const html = '<u data-overlapping="hypercite_39wy5dy,hypercite_ywgsbru" data-hypercite-listener="true">if capital formation were to fall</u>';
    expect(stripHyperciteTags(html)).toBe('if capital formation were to fall');
  });

  it('drops the stale cross-book annotation attributes entirely', () => {
    const out = stripHyperciteTags('<u id="hypercite_abc" class="couple" data-hypercite-listener="true">x</u>');
    expect(out).not.toContain('<u');
    expect(out).not.toContain('data-hypercite-listener');
    expect(out).not.toContain('data-overlapping');
    expect(out).not.toContain('hypercite_abc');
  });

  it('handles the empty anchor-spacing <u> and a real one as siblings', () => {
    const html = "'<u> </u><u data-overlapping=\"hypercite_x\" data-hypercite-listener=\"true\">quote</u>";
    expect(stripHyperciteTags(html)).toBe("' quote");
  });

  it('preserves nested inline formatting inside the hypercite', () => {
    expect(stripHyperciteTags('<u class="poly">see <i>Capital</i> here</u>')).toBe('see <i>Capital</i> here');
  });

  it('leaves plain content untouched and is null-safe', () => {
    expect(stripHyperciteTags('<p>hello <strong>world</strong></p>')).toBe('<p>hello <strong>world</strong></p>');
    expect(stripHyperciteTags('')).toBe('');
    expect(stripHyperciteTags(null)).toBe(null);
  });
});

describe('stripMarkTags (companion — highlights)', () => {
  it('unwraps a highlight <mark>, keeping its text', () => {
    expect(stripMarkTags('<mark class="user-highlight HL_123">noted</mark>')).toBe('noted');
  });
});
