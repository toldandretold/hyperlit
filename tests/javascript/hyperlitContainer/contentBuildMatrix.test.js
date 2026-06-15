/**
 * THE build-combination matrix — pins that buildUnifiedContent assembles exactly the
 * sections for the present content types, once each, in priority order, regardless of
 * how many are present. This is the behaviour the registry refactor reshuffles.
 *
 * The render layer (contentBuilders/display*) is mocked to emit a per-type sentinel, and
 * openDatabase is faked, so we assert pure orchestration (dispatch + order) — no IndexedDB.
 */
import { describe, it, expect, vi } from 'vitest';

// Each builder emits a sentinel section so the concatenated output reveals which ran + order.
vi.mock('../../../resources/js/hyperlitContainer/contentBuilders/displayFootnotes', () => ({
  buildFootnoteContent: vi.fn(async () => '<sec data-type="footnote">'),
}));
vi.mock('../../../resources/js/hyperlitContainer/contentBuilders/displayCitations', () => ({
  buildCitationContent: vi.fn(async () => '<sec data-type="citation">'),
  buildHyperciteCitationContent: vi.fn(async () => '<sec data-type="hypercite-citation">'),
  resolveButtonStatus: vi.fn(),
}));
vi.mock('../../../resources/js/hyperlitContainer/contentBuilders/displayHyperlights', () => ({
  buildHighlightContent: vi.fn(async () => '<sec data-type="highlight">'),
}));
vi.mock('../../../resources/js/hyperlitContainer/contentBuilders/displayHypercites', () => ({
  buildHyperciteContent: vi.fn(async () => '<sec data-type="hypercite">'),
}));

// Fake IDB so the multi-type timestamp path doesn't touch a real database (timestamps → 0).
const fakeDb = {
  transaction: () => ({
    objectStore: () => ({
      index: () => ({
        get: () => { const req = {}; queueMicrotask(() => req.onsuccess && req.onsuccess()); return req; },
      }),
    }),
  }),
};
vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: vi.fn(async () => fakeDb),
}));

import { buildUnifiedContent } from '../../../resources/js/hyperlitContainer/contentBuild';

// Extract the ordered list of section types from the built HTML.
function sectionsOf(html) {
  return [...html.matchAll(/data-type="([^"]+)"/g)].map((m) => m[1]);
}

const ct = (type, extra = {}) => ({ type, ...extra });

describe('buildUnifiedContent — content-build matrix', () => {
  it('one type → only that section', async () => {
    const html = await buildUnifiedContent([ct('footnote')], [], null, true);
    expect(sectionsOf(html)).toEqual(['footnote']);
  });

  it('a subset → those sections in priority order (footnote 2 before highlight 5)', async () => {
    const html = await buildUnifiedContent(
      [ct('highlight', { highlightIds: ['HL_1'] }), ct('footnote')],
      [], null, true,
    );
    expect(sectionsOf(html)).toEqual(['footnote', 'highlight']);
  });

  it('all five → all five in priority order', async () => {
    const all = [
      ct('highlight', { highlightIds: ['HL_1'] }),
      ct('citation'),
      ct('hypercite', { hyperciteId: 'hypercite_1' }),
      ct('footnote'),
      ct('hypercite-citation'),
    ];
    const html = await buildUnifiedContent(all, [], null, true);
    expect(sectionsOf(html)).toEqual([
      'hypercite-citation', // 1
      'footnote',           // 2
      'citation',           // 3
      'hypercite',          // 4
      'highlight',          // 5
    ]);
  });

  it('builds each present type exactly once (no duplicates)', async () => {
    const html = await buildUnifiedContent(
      [ct('footnote'), ct('citation')],
      [], null, true,
    );
    expect(sectionsOf(html)).toEqual(['footnote', 'citation']);
  });

  it('empty input → the no-content error placeholder (real behaviour)', async () => {
    const html = await buildUnifiedContent([], [], null, true);
    expect(html).toContain('No content available');
    expect(sectionsOf(html)).toEqual([]);
  });
});
