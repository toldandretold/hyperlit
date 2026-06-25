/**
 * deriveMainAnchorId — pins the MAIN-PAGE anchor a restored hyperlit container scrolls to.
 *
 * Guards the fix for: back/forward/refresh reopened the container but left the reader stuck
 * (usually at the top) because the restore never scrolled main to the anchor. restoreContainerStack
 * now derives the anchor from the layer's contentMetadata via this function and navigates to it.
 *
 * The render/DOM/IDB siblings history.ts imports are mocked so we test the pure derivation only.
 */
import { describe, it, expect, vi } from 'vitest';

// history.ts pulls these on import — stub them so the module loads without DOM/IDB/manager side effects.
vi.mock('../../../resources/js/hyperlitContainer/detection.js', () => ({ detectHypercites: vi.fn(), detectHighlights: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/subBookActions', () => ({ resetSubBookState: vi.fn(), saveSubBookState: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/contentBuild', () => ({ buildUnifiedContent: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/postOpen', () => ({ handlePostOpenActions: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/permissions', () => ({ checkIfUserHasAnyEditPermission: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/core.js', () => ({
  prepareHyperlitContainer: vi.fn(), animateHyperlitContainerOpen: vi.fn(),
  hyperlitManager: null, getHyperlitEditMode: vi.fn(() => false),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/stack.js', () => ({ getCurrentContainer: vi.fn() }));

import { deriveMainAnchorId } from '../../../resources/js/hyperlitContainer/history';

const meta = (...contentTypes) => ({ contentTypes });

describe('deriveMainAnchorId', () => {
  it('single hypercite → hypercite_<id> (prefix normalised)', () => {
    expect(deriveMainAnchorId(meta({ type: 'hypercite', hyperciteId: 'hypercite_abc' }))).toBe('hypercite_abc');
    // bare id gets the prefix re-added by determineSingleContentHash
    expect(deriveMainAnchorId(meta({ type: 'hypercite', hyperciteId: 'abc' }))).toBe('hypercite_abc');
  });

  it('single highlight → the HL_ id', () => {
    expect(deriveMainAnchorId(meta({ type: 'highlight', highlightIds: ['HL_xyz'] }))).toBe('HL_xyz');
  });

  it('single footnote → its element/footnote id', () => {
    expect(deriveMainAnchorId(meta({ type: 'footnote', elementId: 'Fn12' }))).toBe('Fn12');
    expect(deriveMainAnchorId(meta({ type: 'footnote', footnoteId: 'Fn34' }))).toBe('Fn34');
  });

  it('single citation → citation_<id>', () => {
    expect(deriveMainAnchorId(meta({ type: 'citation', referenceId: 'ref9' }))).toBe('citation_ref9');
  });

  it('multi/overlapping content → falls back to the FIRST type’s main id', () => {
    // determineSingleContentHash returns null for >1 type; we anchor on the first.
    expect(deriveMainAnchorId(meta(
      { type: 'hypercite', hyperciteId: 'hypercite_first' },
      { type: 'highlight', highlightIds: ['HL_second'] },
    ))).toBe('hypercite_first');
    // first type is a highlight with multiple ids → first id
    expect(deriveMainAnchorId(meta(
      { type: 'highlight', highlightIds: ['HL_a', 'HL_b'] },
      { type: 'footnote', footnoteId: 'Fn1' },
    ))).toBe('HL_a');
  });

  it('returns null when there is no anchor information', () => {
    expect(deriveMainAnchorId(null)).toBeNull();
    expect(deriveMainAnchorId({})).toBeNull();
    expect(deriveMainAnchorId({ contentTypes: [] })).toBeNull();
    expect(deriveMainAnchorId(meta({ type: 'hypercite' }))).toBeNull(); // no hyperciteId
  });
});
