/**
 * Tests for the HTML block parser — specifically the <br> splitting that turns
 * a run of <br>-separated paragraphs (inside one <p>) into separate blocks.
 */

import { describe, it, expect } from 'vitest';
import { parseHtmlToBlocks } from '../../../resources/js/paste/utils/html-block-parser';

describe('parseHtmlToBlocks — <br> splitting', () => {
  it('splits a <p> on bare <br> tags', () => {
    const blocks = parseHtmlToBlocks('<p><span>A</span><br><span>B</span></p>');
    expect(blocks.length).toBe(2);
  });

  it('splits a <p> on attribute-bearing <br> tags (DeepL paste)', () => {
    // Regression: /<br\s*\/?>/i missed these, collapsing the whole run into one node.
    const html = '<p><span>A</span><br data-dl-uid="1" data-dl-original="true"><br data-dl-uid="2"><span>B</span></p>';
    const blocks = parseHtmlToBlocks(html);
    expect(blocks.length).toBe(2);
    expect(blocks.join('')).toContain('A');
    expect(blocks.join('')).toContain('B');
  });

  it('does not split a <p> with no <br>', () => {
    const blocks = parseHtmlToBlocks('<p>Just one paragraph</p>');
    expect(blocks.length).toBe(1);
  });
});
