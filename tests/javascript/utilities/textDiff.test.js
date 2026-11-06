/**
 * textDiff — the word-level LCS diff behind the suggested-edit before/after
 * rendering. Pure leaf: no mocks.
 */
import { describe, it, expect } from 'vitest';
import { diffWords, renderDiffHtml } from '../../../resources/js/utilities/textDiff.ts';

const joined = (parts, types) => parts.filter((p) => types.includes(p.type)).map((p) => p.text).join('');

describe('diffWords', () => {
  it('identical strings are one same part', () => {
    const parts = diffWords('the quick brown fox', 'the quick brown fox');
    expect(parts).toEqual([{ type: 'same', text: 'the quick brown fox' }]);
  });

  it('a pure insertion is an add part', () => {
    const parts = diffWords('the fox', 'the quick fox');
    expect(parts.map((p) => p.type)).toEqual(['same', 'add', 'same']);
    expect(parts[1].text.trim()).toBe('quick');
  });

  it('a pure deletion is a del part', () => {
    const parts = diffWords('the quick fox', 'the fox');
    expect(parts.some((p) => p.type === 'del' && p.text.trim() === 'quick')).toBe(true);
  });

  it('a replacement yields del + add', () => {
    const parts = diffWords('indeterminacy is semantic', 'indeterminacy is structural');
    const types = parts.map((p) => p.type);
    expect(types).toContain('del');
    expect(types).toContain('add');
    expect(joined(parts, ['del']).trim()).toBe('semantic');
    expect(joined(parts, ['add']).trim()).toBe('structural');
  });

  it('same + add parts reassemble to the AFTER string exactly', () => {
    const before = 'one two three four five';
    const after = 'one 2 three  four six';
    const parts = diffWords(before, after);
    expect(joined(parts, ['same', 'add'])).toBe(after);
  });

  it('empty before/after degrade to a single add/del', () => {
    expect(diffWords('', 'all new')).toEqual([{ type: 'add', text: 'all new' }]);
    expect(diffWords('all gone', '')).toEqual([{ type: 'del', text: 'all gone' }]);
    expect(diffWords('', '')).toEqual([]);
  });
});

describe('renderDiffHtml', () => {
  it('wraps adds in ins and dels in del with the se- classes', () => {
    const html = renderDiffHtml(diffWords('keep old end', 'keep new end'));
    expect(html).toContain('<del class="se-del">old </del>');
    expect(html).toContain('<ins class="se-add">new </ins>');
    expect(html).toContain('keep ');
  });

  it('escapes HTML in every part type', () => {
    const html = renderDiffHtml(diffWords('<b>bold</b>', '<i>italic</i> <b>bold</b>'));
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;i&gt;italic&lt;/i&gt;');
  });
});
