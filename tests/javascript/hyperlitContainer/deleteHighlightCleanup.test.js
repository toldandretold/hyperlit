/**
 * Post-delete cleanup for a highlight shown in the hyperlit container
 * (`contentTypes/hyperlightHandler.ts` → `dismissDeletedHighlight` / `removeHighlightBlock`).
 *
 * THE BUG THIS LOCKS: the delete button awaited `deleteHighlightById` and returned. Nothing
 * touched the container or the URL, so the layer went on rendering the highlight that had
 * just been destroyed — which reads as a freeze — and, in a stacked layer, the address bar
 * still named the sub-book the delete had just deleted. Refreshing there hit
 * TextController::showNested and 404'd (see tests/Feature/Routing/DeletedSubBookFallbackTest.php
 * for the server-side half).
 *
 * Popping the layer (or closing the base container) is what restores the parent's URL — both
 * paths already do that cleanup, they were simply never called from the delete path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factories are hoisted above every other statement, so their state has to be
// hoisted with them — a plain `const` above would still be in its TDZ when they run.
const m = vi.hoisted(() => ({
  popTopLayer: vi.fn(),
  closeHyperlitContainer: vi.fn(),
  container: null,
  stacked: false,
}));

vi.mock('../../../resources/js/hyperlitContainer/stack', () => ({
  getCurrentContainer: () => m.container,
  isStacked: () => m.stacked,
  popTopLayer: m.popTopLayer,
}));
vi.mock('../../../resources/js/hyperlitContainer/core.js', () => ({
  closeHyperlitContainer: m.closeHyperlitContainer,
}));

// Heavy transitive deps of the handler module — irrelevant to these two helpers.
vi.mock('../../../resources/js/hyperlitContainer/contentBuilders/displayHyperlights', () => ({
  buildHighlightContent: vi.fn(),
}));
vi.mock('../../../resources/js/hyperlitContainer/containerState', () => ({
  containerState: {},
  registerListener: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: vi.fn() }));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getAuthContextSync: vi.fn(),
  getAuthContext: vi.fn(),
}));

import {
  dismissDeletedHighlight,
  removeHighlightBlock,
} from '../../../resources/js/hyperlitContainer/contentTypes/hyperlightHandler';

/**
 * displayHyperlights emits a FLAT run of siblings per highlight — no wrapper element —
 * so the fixture has to reproduce that shape exactly for the sweep to be meaningful.
 */
function highlightBlock(id, { withHr = true } = {}) {
  return `
    <div class="author" id="author-${id}"><b>someone</b></div>
    <blockquote class="highlight-text" data-highlight-id="${id}">"quoted"</blockquote>
    <div class="highlight-annotation" data-highlight-id="${id}"></div>
    <br>
    ${withHr ? '<hr>' : ''}
  `;
}

function mountContainer(ids) {
  const container = document.createElement('div');
  container.id = 'hyperlit-container';
  container.innerHTML = `<div class="scroller">${
    ids.map((id, i) => highlightBlock(id, { withHr: i < ids.length - 1 })).join('')
  }</div>`;
  document.body.appendChild(container);
  m.container = container;
  return container;
}

const authorIds = (container) =>
  [...container.querySelectorAll('.author[id^="author-"]')].map((el) => el.id.replace('author-', ''));

beforeEach(() => {
  document.body.innerHTML = '';
  m.container = null;
  m.stacked = false;
  m.popTopLayer.mockReset().mockResolvedValue(undefined);
  m.closeHyperlitContainer.mockReset().mockResolvedValue(undefined);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('removeHighlightBlock', () => {
  it('sweeps exactly one highlight\'s flat run and leaves its siblings intact', () => {
    const container = mountContainer(['HL_a', 'HL_b', 'HL_c']);

    removeHighlightBlock(container, 'HL_b');

    expect(authorIds(container)).toEqual(['HL_a', 'HL_c']);
    // The swept run took its own blockquote and annotation with it, and only those.
    expect(container.querySelectorAll('[data-highlight-id="HL_b"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-highlight-id="HL_a"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-highlight-id="HL_c"]')).toHaveLength(2);
  });

  it('does not leave a dangling separator when the LAST highlight goes', () => {
    const container = mountContainer(['HL_a', 'HL_b']);

    removeHighlightBlock(container, 'HL_b');

    expect(authorIds(container)).toEqual(['HL_a']);
    expect(container.querySelectorAll('hr')).toHaveLength(0);
  });

  it('is a no-op for an id the container is not showing', () => {
    const container = mountContainer(['HL_a']);
    removeHighlightBlock(container, 'HL_missing');
    expect(authorIds(container)).toEqual(['HL_a']);
  });
});

describe('dismissDeletedHighlight', () => {
  it('pops the layer when a STACKED layer was showing only the deleted highlight', async () => {
    mountContainer(['HL_only']);
    m.stacked = true;

    await dismissDeletedHighlight('HL_only');

    // Popping is what restores the parent layer's URL — the whole point.
    expect(m.popTopLayer).toHaveBeenCalledTimes(1);
    expect(m.closeHyperlitContainer).not.toHaveBeenCalled();
  });

  it('closes the base container when it was showing only the deleted highlight', async () => {
    mountContainer(['HL_only']);
    m.stacked = false;

    await dismissDeletedHighlight('HL_only');

    // closeHyperlitContainer is the path that strips cascade segments + ?cs from the URL.
    expect(m.closeHyperlitContainer).toHaveBeenCalledTimes(1);
    expect(m.popTopLayer).not.toHaveBeenCalled();
  });

  it('keeps a layer of OVERLAPPING highlights open, removing only the deleted one', async () => {
    const container = mountContainer(['HL_a', 'HL_b']);
    m.stacked = true;

    await dismissDeletedHighlight('HL_a');

    expect(authorIds(container)).toEqual(['HL_b']);
    // Still live content, and the URL still describes it correctly — do not retire the layer.
    expect(m.popTopLayer).not.toHaveBeenCalled();
    expect(m.closeHyperlitContainer).not.toHaveBeenCalled();
  });

  it('does nothing when no container is open', async () => {
    m.container = null;
    await dismissDeletedHighlight('HL_a');
    expect(m.popTopLayer).not.toHaveBeenCalled();
    expect(m.closeHyperlitContainer).not.toHaveBeenCalled();
  });
});
