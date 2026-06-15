/**
 * Characterization of isContentLink (hyperlights/deletion.js) — the predicate
 * that decides whether an <a> is a USER content link (unwrappable on delete)
 * vs a system link (footnote/citation/hypercite). Pinned before .js → .ts.
 *
 * (deleteHighlightById/hideHighlightById are DOM+IDB orchestration over the
 * already-pinned removeHighlight* writes; exercised by the e2e grand tour.)
 */
import { describe, it, expect, vi } from 'vitest';

// deletion.js → ./listeners → hyperlitContainer/index breaks under happy-dom.
vi.mock('../../../resources/js/hyperlitContainer/index', () => ({
  handleUnifiedContentClick: vi.fn(), initializeHyperlitManager: vi.fn(),
  openHyperlitContainer: vi.fn(), closeHyperlitContainer: vi.fn(),
}));

import { isContentLink } from '../../../resources/js/hyperlights/deletion';

const a = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

describe('isContentLink', () => {
  it('is true for a plain user link with an href', () => {
    expect(isContentLink(a('<a href="https://x.com">link</a>'))).toBe(true);
  });

  it('is false for non-anchors / hrefless anchors', () => {
    expect(isContentLink(a('<span>x</span>'))).toBe(false);
    expect(isContentLink(a('<a>no href</a>'))).toBe(false);
    expect(isContentLink(null)).toBe(false);
  });

  it('is false for system links: footnote-ref, hypercite id, fn-sup, citation section', () => {
    expect(isContentLink(a('<a href="#" class="footnote-ref">1</a>'))).toBe(false);
    expect(isContentLink(a('<a href="#" id="hypercite_abc">↗</a>'))).toBe(false);

    const sup = document.createElement('sup');
    sup.setAttribute('fn-count-id', '1');
    sup.innerHTML = '<a href="#">1</a>';
    expect(isContentLink(sup.querySelector('a'))).toBe(false);

    const section = document.createElement('div');
    section.className = 'hypercites-section';
    section.innerHTML = '<a href="#">cite</a>';
    expect(isContentLink(section.querySelector('a'))).toBe(false);
  });
});
