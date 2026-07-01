/**
 * Characterization of resources/js/hyperlights/utils.js — ID generation +
 * the legacy openHighlightById redirect + placeholder behavior. Pinned
 * before .js → .ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handleUnifiedContentClick } = vi.hoisted(() => ({ handleUnifiedContentClick: vi.fn().mockResolvedValue(undefined) }));
// hyperlights now reaches the container via the containerActions DI registry, not hyperlitContainer/index.
vi.mock('../../../resources/js/hyperlitContainer/containerActions', () => ({ handleUnifiedContentClick, registerContainerActions: vi.fn() }));

import { generateHighlightID, openHighlightById, attachPlaceholderBehavior } from '../../../resources/js/hyperlights/utils';

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

describe('generateHighlightID', () => {
  it('is HL_<timestamp>', () => {
    expect(generateHighlightID()).toMatch(/^HL_\d+$/);
  });
});

describe('openHighlightById', () => {
  it('passes the real <mark> element when it exists', async () => {
    const mark = document.createElement('mark');
    mark.classList.add('HL_x');
    document.body.appendChild(mark);

    await openHighlightById('HL_x');
    expect(handleUnifiedContentClick).toHaveBeenCalledWith(mark, ['HL_x'], []);
  });

  it('routes through the direct-ID path (element=null, directId) when the mark is not in the DOM', async () => {
    // Previously fabricated a fake MARK object with no DOM methods, which threw
    // "element.closest is not a function" in handleUnifiedContentClick during rapid
    // nav (froze cross-book back/forward). Now it uses the direct highlight-ID path.
    await openHighlightById('HL_absent', false, ['HL_new']);
    const [el, ids, newIds, skipUrl, isBack, directId] = handleUnifiedContentClick.mock.calls[0];
    expect(el).toBeNull();
    expect(newIds).toEqual(['HL_new']);
    expect(directId).toBe('HL_absent');
  });
});

describe('attachPlaceholderBehavior', () => {
  it('toggles the empty-annotation class based on content (initial check)', () => {
    const empty = document.createElement('div');
    empty.className = 'annotation';
    empty.setAttribute('data-highlight-id', 'HL_e');
    document.body.appendChild(empty);
    attachPlaceholderBehavior('HL_e');
    expect(empty.classList.contains('empty-annotation')).toBe(true);

    const filled = document.createElement('div');
    filled.className = 'annotation';
    filled.setAttribute('data-highlight-id', 'HL_f');
    filled.textContent = 'has text';
    document.body.appendChild(filled);
    attachPlaceholderBehavior('HL_f');
    expect(filled.classList.contains('empty-annotation')).toBe(false);
  });
});
