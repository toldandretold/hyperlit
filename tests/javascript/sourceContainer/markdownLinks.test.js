/**
 * Link handling for the single-book Markdown download —
 * resources/js/components/sourceContainer/markdownLinks.ts (client mirror of
 * BookMarkdownExporter's convertFragment / absolutizeLinks).
 *
 * What these pin:
 *  - a hypercite arrow INSIDE a footnote body is written inline as the cited
 *    book's citation linking hyperlit — it used to ship as `[↗](/book_x#…)`, a
 *    relative link Obsidian resolves as a note path and answers with a blank note;
 *  - every other root-relative link is absolutized, while in-page `#fragment`,
 *    protocol-relative and absolute links are left alone.
 */
import { describe, it, expect } from 'vitest';
import {
  absolutizeLinks,
  parseHyperciteHref,
  prepareFootnoteHtml,
} from '../../../resources/js/components/sourceContainer/markdownLinks';

const ORIGIN = 'https://hyperlit.io';

/** Stand-in for Turndown: links → [text](href), everything else → its text. */
function toMarkdown(html) {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild;
  root.querySelectorAll('a[href]').forEach((a) => {
    a.replaceWith(`[${a.textContent}](${a.getAttribute('href')})`);
  });
  return root.textContent;
}

describe('parseHyperciteHref', () => {
  it('names the cited book (first segment) and the absolute deep URL', () => {
    expect(parseHyperciteHref('/book_1/Fn2_x#hypercite_abc', ORIGIN)).toEqual({
      targetBookId: 'book_1',
      sourceUrl: 'https://hyperlit.io/book_1/Fn2_x#hypercite_abc',
    });
  });

  it('refuses an href with no path', () => {
    expect(parseHyperciteHref('#hypercite_abc', ORIGIN + '/')).toBeNull();
    expect(parseHyperciteHref(null, ORIGIN)).toBeNull();
  });
});

describe('prepareFootnoteHtml', () => {
  it('writes a hypercite arrow inline as a citation linking hyperlit', async () => {
    const html = '<p>\'the commons is about groups.\'<a href="/book_9#hypercite_abc" id="hypercite_zz" class="open-icon">↗</a> and <a href="/u/someone">here</a>.</p>';
    const seen = [];
    const prepared = await prepareFootnoteHtml(html, ORIGIN, async (target) => {
      seen.push(target);
      return `Jane Author, “[A Title](${target.sourceUrl})”, 2019.`;
    });

    const md = prepared.finish(toMarkdown(prepared.html));

    expect(seen).toEqual([{ targetBookId: 'book_9', sourceUrl: 'https://hyperlit.io/book_9#hypercite_abc' }]);
    expect(md).toBe(
      "'the commons is about groups.' (Jane Author, “[A Title](https://hyperlit.io/book_9#hypercite_abc)”, 2019) and [here](https://hyperlit.io/u/someone)."
    );
    expect(md).not.toContain('](/');
    expect(md).not.toContain('↗');
  });

  it('handles the nested <a><sup class="open-icon"> shape and several arrows', async () => {
    const html = '<p>One<a href="/a#hypercite_1"><sup class="open-icon">↗</sup></a> two<a href="/b#hypercite_2" class="open-icon">↗</a></p>';
    const prepared = await prepareFootnoteHtml(html, ORIGIN, async (t) => `C-${t.targetBookId}.`);

    expect(prepared.finish(toMarkdown(prepared.html))).toBe('One (C-a) two (C-b)');
  });

  it('leaves a footnote with no arrows untouched apart from absolutizing', async () => {
    const prepared = await prepareFootnoteHtml('<p>Plain <a href="https://example.org/x">link</a>.</p>', ORIGIN, async () => 'never');

    expect(prepared.finish(toMarkdown(prepared.html))).toBe('Plain [link](https://example.org/x).');
  });
});

describe('absolutizeLinks', () => {
  it('touches only root-relative hrefs', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="/some-book">a</a><a href="#sec2">b</a><a href="//cdn.example/x">c</a><a href="https://example.org">d</a><a href="mailto:x@y.z">e</a>';

    absolutizeLinks(root, ORIGIN + '/');

    expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://hyperlit.io/some-book',
      '#sec2',
      '//cdn.example/x',
      'https://example.org',
      'mailto:x@y.z',
    ]);
  });
});
