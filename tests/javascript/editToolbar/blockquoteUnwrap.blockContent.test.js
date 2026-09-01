/**
 * @vitest-environment jsdom
 *
 * MUST run under jsdom: the assertions re-parse outerHTML, relying on the HTML
 * parser rule happy-dom does not implement — a block start tag CLOSES an open <p>.
 *
 * DATA-LOSS GUARD — unwrapping a blockquote must never build `<p><ul>…</ul></p>`.
 * ================================================================================
 * _contentPreservingUnwrap (blockquote/pre → paragraph toggle) moves ALL the
 * source's children into a freshly created element. A blockquote may legally
 * contain block children (a <ul>, a nested <p>); a <p> may not — the result
 * survived in the live DOM but collapsed to an EMPTY node on its next parse
 * (reload, DOMPurify, the integrity verifier's read-back). Same invalid-nesting
 * class as prod report book_1788217034868 (2026-08-31, "DOM 36 chars, IDB 0 chars").
 *
 * Fix: when the source holds a block-level (or <li>) child, unwrap into a <div>.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/editToolbar/toolbarDOMUtils', () => ({
  findClosestBlockParent: vi.fn(),
  getBlockElementsInRange: vi.fn(() => []),
  getTextOffsetInElement: vi.fn(() => 0),
  setCursorAtTextOffset: vi.fn(),
  selectAcrossElements: vi.fn(),
  findClosestListItem: vi.fn(),
  isBlockElement: vi.fn(() => true),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  batchUpdateIndexedDBRecords: vi.fn(async () => {}),
}));
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  setElementIds: vi.fn(),
  findPreviousElementId: vi.fn(() => null),
  findNextElementId: vi.fn(() => null),
  asLineId: (id) => id,
}));

import {
  _contentPreservingUnwrap,
  _contentPreservingWrap,
} from '../../../resources/js/editToolbar/blockFormat/blockquoteCodeFormat';

/** The integrity verifier's read-back: what a stored string keeps after a parse. */
function textAfterReparse(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild || doc.body;
  return el.textContent.trim();
}

function buildBlockquote(innerHTML) {
  const bq = document.createElement('blockquote');
  bq.id = '300';
  bq.setAttribute('data-node-id', 'book_test_bq');
  bq.innerHTML = innerHTML;
  document.body.appendChild(bq);
  return bq;
}

beforeEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('_contentPreservingUnwrap — block children in the source', () => {
  it('still unwraps inline-only content to a <p>', () => {
    const bq = buildBlockquote('just <strong>inline</strong> content');
    const result = _contentPreservingUnwrap({}, bq, 'blockquote');

    expect(result.tagName).toBe('P');
    expect(result.textContent).toBe('just inline content');
    expect(result.id).toBe('300');
  });

  it('unwraps a blockquote holding a <ul> into a <div>, not a <p>', () => {
    const bq = buildBlockquote('<ul><li>Search Google Scholar</li><li>Export Citation</li></ul>');
    const result = _contentPreservingUnwrap({}, bq, 'blockquote');

    expect(result.tagName).toBe('DIV');
    expect(result.id).toBe('300');
    expect(result.getAttribute('data-node-id')).toBe('book_test_bq');
    // The exact comparison that reported "DOM 36 chars, IDB 0 chars":
    expect(textAfterReparse(result.outerHTML)).toBe(result.textContent.trim());
    expect(textAfterReparse(result.outerHTML)).toContain('Search Google Scholar');
  });

  it('guards mixed content (text + list) the same way', () => {
    const bq = buildBlockquote('a citation<ul><li>with chrome</li></ul>');
    const result = _contentPreservingUnwrap({}, bq, 'blockquote');

    expect(result.tagName).toBe('DIV');
    expect(textAfterReparse(result.outerHTML)).toContain('with chrome');
  });

  it('round-trips: wrap to blockquote then unwrap never loses text through a re-parse', () => {
    const bq = buildBlockquote('<ul><li>alpha</li><li>beta</li></ul>');
    const unwrapped = _contentPreservingUnwrap({}, bq, 'blockquote');
    const rewrapped = _contentPreservingWrap({}, unwrapped, 'blockquote');
    const again = _contentPreservingUnwrap({}, rewrapped, 'blockquote');

    expect(textAfterReparse(again.outerHTML)).toContain('alpha');
    expect(textAfterReparse(again.outerHTML)).toContain('beta');
  });
});
