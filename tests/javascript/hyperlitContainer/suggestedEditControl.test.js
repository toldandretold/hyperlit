/**
 * Suggested-edit UI builders (hyperlitContainer/suggestedEditControl.ts):
 * the gating matrix for who sees the ✎ offer, the pending diff + action rows,
 * and the resolved badge — all as pure HTML-building assertions.
 */
import { describe, it, expect, vi } from 'vitest';

// The control imports the data + accept layers (which pull IDB/auth); builders
// never call them, so stub the modules out.
vi.mock('../../../resources/js/hyperlights/suggestedEdit', () => ({
  getHighlightRecord: vi.fn(),
  getSuggestionSegments: vi.fn(),
  saveSuggestion: vi.fn(),
  withdrawSuggestion: vi.fn(),
  resolveSuggestion: vi.fn(),
}));
vi.mock('../../../resources/js/hyperlights/suggestedEditAccept', () => ({
  acceptSuggestion: vi.fn(),
}));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn(),
  alertDialog: vi.fn(),
}));

import { buildHighlightTextBlockHtml } from '../../../resources/js/hyperlitContainer/suggestedEditControl.ts';

const BOOK = 'book_ui_test';
const NODE = `${BOOK}_1_aaaa`;

function record(extra = {}) {
  return {
    book: BOOK,
    hyperlight_id: 'HL_ui',
    node_id: [NODE],
    charData: { [NODE]: { charStart: 0, charEnd: 5 } },
    highlightedText: 'the marked passage',
    highlightedHTML: 'the marked passage',
    annotation: '',
    suggested_text: null,
    suggestion_status: null,
    ...extra,
  };
}

const OPTS = { isUserHighlight: false, canEditBook: false, contentEditable: false, canEdit: false };
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

describe('plain state — the ✎ offer', () => {
  it('creator on someone else\'s book sees the ✎', () => {
    const html = buildHighlightTextBlockHtml(record(), { ...OPTS, isUserHighlight: true });
    expect(html).toContain('suggest-edit-btn');
  });

  it('creator on their OWN book sees it too (staged edit / MCP agent-as-user shape)', () => {
    const html = buildHighlightTextBlockHtml(record(), { ...OPTS, isUserHighlight: true, canEditBook: true });
    expect(html).toContain('suggest-edit-btn');
  });

  it('a non-creator viewer never sees the ✎', () => {
    expect(buildHighlightTextBlockHtml(record(), OPTS)).not.toContain('suggest-edit-btn');
    expect(buildHighlightTextBlockHtml(record(), { ...OPTS, canEditBook: true })).not.toContain('suggest-edit-btn');
  });

  it('a ghosted anchor suppresses the ✎', () => {
    const ghosted = record({ charData: { [NODE]: { charStart: -1, charEnd: -1 } } });
    const html = buildHighlightTextBlockHtml(ghosted, { ...OPTS, isUserHighlight: true });
    expect(html).not.toContain('suggest-edit-btn');
  });

  it('renders the truncated quote and keeps the editability attributes', () => {
    const long = record({ highlightedText: 'x'.repeat(200) });
    const html = buildHighlightTextBlockHtml(long, { ...OPTS, isUserHighlight: true, contentEditable: true, canEdit: true });
    expect(html).toContain('x'.repeat(140) + '...');
    expect(html).not.toContain('x'.repeat(141));
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('data-user-can-edit="true"');
  });
});

describe('pending state — the diff + action rows', () => {
  const pending = () => record({
    suggested_text: { [NODE]: { before: 'the marked passage', after: 'the improved passage' } },
    suggestion_status: 'pending',
  });

  it('every viewer sees the before/after diff instead of the plain quote', () => {
    const html = buildHighlightTextBlockHtml(pending(), OPTS);
    const node = el(html);
    expect(node.classList.contains('suggestion-diff')).toBe(true);
    expect(node.querySelector('del.se-del')?.textContent).toContain('marked');
    expect(node.querySelector('ins.se-add')?.textContent).toContain('improved');
    // Never editable — editMode's toggle keys off data-user-can-edit="true".
    expect(node.getAttribute('contenteditable')).toBe('false');
    expect(node.getAttribute('data-user-can-edit')).toBe('false');
  });

  it('the BOOK OWNER gets Accept / like / Decline', () => {
    const html = buildHighlightTextBlockHtml(pending(), { ...OPTS, canEditBook: true });
    const node = el(html);
    expect(node.querySelector('.suggestion-action[data-action="accept"]')).not.toBeNull();
    expect(node.querySelector('.suggestion-action[data-action="rejected"]')).not.toBeNull();
    expect(node.querySelector('.suggestion-action[data-action="liked"]')).not.toBeNull();
  });

  it('the SUGGESTER gets re-edit + withdraw, not the verdict row', () => {
    const html = buildHighlightTextBlockHtml(pending(), { ...OPTS, isUserHighlight: true });
    const node = el(html);
    expect(node.querySelector('.suggestion-reedit')).not.toBeNull();
    expect(node.querySelector('.suggestion-withdraw')).not.toBeNull();
    expect(node.querySelector('[data-action="accept"]')).toBeNull();
  });

  it('a SELF-suggestion (owner == suggester) composes both roles, ♥ included', () => {
    const html = buildHighlightTextBlockHtml(pending(), { ...OPTS, isUserHighlight: true, canEditBook: true });
    const node = el(html);
    expect(node.querySelector('[data-action="accept"]')).not.toBeNull();
    expect(node.querySelector('[data-action="rejected"]')).not.toBeNull();
    // The author liking their own draft is a meaningful endorsement, not self-flattery.
    expect(node.querySelector('[data-action="liked"]')).not.toBeNull();
    expect(node.querySelector('.suggestion-withdraw')).not.toBeNull();
    expect(node.querySelector('.suggestion-reedit')).not.toBeNull();
  });

  it('the liked state is attributed to the author', () => {
    const liked = record({
      suggested_text: { [NODE]: { before: 'old words', after: 'new words' } },
      suggestion_status: 'liked',
    });
    const node = el(buildHighlightTextBlockHtml(liked, OPTS));
    expect(node.querySelector('.suggestion-badge-liked')?.textContent).toContain('author');
  });

  it('a bystander sees the diff with no actions at all', () => {
    const node = el(buildHighlightTextBlockHtml(pending(), OPTS));
    expect(node.querySelector('.suggestion-actions')).toBeNull();
  });

  it('diff content is escaped', () => {
    const nasty = record({
      suggested_text: { [NODE]: { before: '<img src=x onerror=1>', after: '<script>alert(1)</script>' } },
      suggestion_status: 'pending',
    });
    const html = buildHighlightTextBlockHtml(nasty, OPTS);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });
});

describe('resolved states — badge + VISIBLE diff (still reads as a suggestion)', () => {
  const resolved = (status) => record({
    suggested_text: { [NODE]: { before: 'old words', after: 'new words' } },
    suggestion_status: status,
  });

  it.each(['accepted', 'rejected', 'liked'])('%s keeps the before/after diff visible with a status badge', (status) => {
    const node = el(buildHighlightTextBlockHtml(resolved(status), OPTS));
    // Still framed as a suggestion (diff blockquote), NOT collapsed behind a toggle.
    expect(node.classList.contains('suggestion-diff')).toBe(true);
    expect(node.querySelector('details')).toBeNull();
    // Keeps the "Suggested edit" chip so it still reads as a suggestion at a glance.
    expect(node.querySelector('.suggestion-chip')).not.toBeNull();
    expect(node.querySelector(`.suggestion-badge-${status}`)).not.toBeNull();
    expect(node.querySelector('ins.se-add')?.textContent).toContain('new');
    expect(node.querySelector('del.se-del')?.textContent).toContain('old');
    // No verdict buttons on a resolved suggestion.
    expect(node.querySelector('[data-action="accept"]')).toBeNull();
  });
});

describe('revert affordance', () => {
  const accepted = () => record({
    suggested_text: { [NODE]: { before: 'old words', after: 'new words' } },
    suggestion_status: 'accepted',
  });

  it('the BOOK OWNER sees Revert on an accepted suggestion', () => {
    const node = el(buildHighlightTextBlockHtml(accepted(), { ...OPTS, canEditBook: true }));
    expect(node.querySelector('.suggestion-revert')).not.toBeNull();
  });

  it('rejected and liked offer Reconsider (not Revert) to the owner; non-owners get nothing', () => {
    const rejected = record({
      suggested_text: { [NODE]: { before: 'a', after: 'b' } },
      suggestion_status: 'rejected',
    });
    const liked = record({
      suggested_text: { [NODE]: { before: 'a', after: 'b' } },
      suggestion_status: 'liked',
    });
    // Owner: Reconsider, never Revert (nothing was applied to undo).
    const rejNode = el(buildHighlightTextBlockHtml(rejected, { ...OPTS, canEditBook: true }));
    expect(rejNode.querySelector('.suggestion-reopen')).not.toBeNull();
    expect(rejNode.querySelector('.suggestion-revert')).toBeNull();
    expect(el(buildHighlightTextBlockHtml(liked, { ...OPTS, canEditBook: true })).querySelector('.suggestion-reopen')).not.toBeNull();
    // Non-owner: no action on any resolved state.
    expect(el(buildHighlightTextBlockHtml(accepted(), OPTS)).querySelector('.suggestion-revert')).toBeNull();
    expect(el(buildHighlightTextBlockHtml(rejected, OPTS)).querySelector('.suggestion-reopen')).toBeNull();
  });
});
