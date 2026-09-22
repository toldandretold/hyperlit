/**
 * ScienceDirect: the footnote citation style.
 *
 * Real prod paste (Journal of Historical Geography, doi 10.1016/j.jhg.2025.07.004
 * — captured in fixtures/clipboard/sciencedirect-footnotes.html). Every SD
 * capture the engine had seen until 2026-09 was AUTHOR-DATE, so
 * `ScienceDirectProcessor.extractFootnotes()` hard-returned `[]` with the
 * comment "Science Direct typically uses inline references, not footnotes".
 *
 * The two styles share one anchor vocabulary, and that is what turned a missing
 * feature into data loss. A bibliography link is
 *   <a data-xocs-content-type="reference" data-xocs-content-id="b0120">
 * and a NOTE marker is
 *   <a data-xocs-content-type="reference" data-xocs-content-id="fn1"><sup>1</sup></a>
 * — same content-type, only the id prefix differs. `convertCitationLinks()`
 * therefore matched all 109 markers, failed to find a reference for "fn1", and
 * took its not-found branch: replace the anchor with its own text. So the notes
 * were lost AND each marker became a bare digit welded to the sentence it
 * followed ("…to elect a communist government.1 Five years later…").
 *
 * The definitions are one <dl class="footnote"> per note. The label's fragment
 * is the MARKER's `name` (`#bfn1`); the marker's own id is `fn1`, which is the
 * key the two halves are matched on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFormat, getProcessorForContent } from '../../../resources/js/paste/format-detection/format-detector';
import { prepareClipboardHtml, convertDefinitionListTags } from '../../../resources/js/paste/utils/normalizer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'clipboard');
const FOOTNOTE_ARTICLE = join(FIXTURE_DIR, 'sciencedirect-footnotes.html');
const AUTHOR_DATE_ARTICLE = join(FIXTURE_DIR, 'sciencedirect.html');

const footnoteArticle = readFileSync(FOOTNOTE_ARTICLE, 'utf8');
const authorDateArticle = readFileSync(AUTHOR_DATE_ARTICLE, 'utf8');

/**
 * The REAL lane: handlePaste's structural preparation, then the processor, then
 * the post-processing conversions. Running `processor.process(html)` directly
 * is what let this bug ship — `convertDefinitionListTags` ran BEFORE detection
 * in the handler, flattening every `<dl class="footnote">` to bare `<p>`s, so
 * the browser extracted 0 notes while a processor-only test saw all 109.
 */
async function run(html) {
  const prepared = prepareClipboardHtml(html);
  const { processor } = getProcessorForContent(prepared);
  const result = await processor.process(prepared, 'fixtureBook');
  return { ...result, html: convertDefinitionListTags(result.html) };
}

describe('ScienceDirect footnote articles', () => {
  it('routes to the ScienceDirect processor', () => {
    expect(detectFormat(footnoteArticle)).toBe('science-direct');
  });

  it('extracts every <dl class="footnote"> note and links its marker', async () => {
    const result = await run(footnoteArticle);

    expect(result.footnotes).toHaveLength(109);
    expect((result.html.match(/fn-count-id=/g) || [])).toHaveLength(109);

    // Identifiers are the DISPLAYED numbers, contiguous 1..109.
    const identifiers = result.footnotes.map((fn) => fn.originalIdentifier);
    expect(identifiers.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(identifiers[108]).toBe('109');

    // Content is the <dd>, matched to the right marker.
    expect(result.footnotes[1].content).toContain('Memoir of an Indian Communist');
  }, 20_000);

  it('never leaves a marker as a bare digit in the prose', async () => {
    const result = await run(footnoteArticle);

    // The original regression, verbatim: the anchor was replaced by its own
    // text, gluing "1" onto the end of the sentence.
    expect(result.html).not.toContain('communist government.1 Five years');
    expect(result.html).toMatch(/communist government\.<sup[^>]*fn-count-id="1"/);
  }, 20_000);

  it('does not ship raw sciencedirect.com marker anchors', async () => {
    const result = await run(footnoteArticle);

    expect(result.html).not.toMatch(/data-xocs-content-id="fn\d/);
    expect(result.html).not.toMatch(/<a[^>]*#fn\d+"/);
  }, 20_000);

  it('keeps the URL a note cites', async () => {
    const result = await run(footnoteArticle);

    // Footnote content is cleaned with the SVG chrome removed but the anchors
    // kept: an SD note cites bare URLs, and the anchor's text IS the locator.
    // Stripping `a[target="_blank"]` the way the reference extractor does would
    // delete the only thing a citation resolver could fetch.
    expect(result.html).toContain(
      'https://www.thehindu.com/todays-paper/tp-national/tp-kerala/how-paavangal-enriched-kerala/article3447976.ece',
    );
  }, 20_000);

  it('keeps an unlabelled note as prose, and as a real paragraph', async () => {
    const result = await run(footnoteArticle);

    // SD puts article-level statements in a <dl class="footnote"> with an EMPTY
    // <dt> — there is no marker anywhere in the body, so it must not become a
    // numbered note. It also must not survive as a <dl>: cleanup nests the
    // leftover list inside a <p>, and a block inside a <p> splits into an empty
    // tagged node plus an untagged orphan when the paste is stored.
    expect(result.html).toContain(
      '<p>This article is part of a special issue entitled: Archives as Worldmaking published in Journal of Historical Geography.</p>',
    );
    expect(result.html).not.toContain('<dl');
  }, 20_000);
});

describe('ScienceDirect author-date articles keep their notes too', () => {
  it('extracts the two notes the author-date fixture also carries', async () => {
    const result = await run(authorDateArticle);

    expect(result.footnotes).toHaveLength(2);
    expect((result.html.match(/fn-count-id=/g) || [])).toHaveLength(2);
    expect(result.references).toHaveLength(88);
  }, 20_000);

  it('converts a citation that lives INSIDE a note', async () => {
    const result = await run(authorDateArticle);

    // Note 2 cites "(Lenin, 1920)". Footnote bodies are lifted out of the DOM at
    // stage 2, BEFORE convertCitationLinks runs over it, so a citation inside a
    // note is never reached by the body pass — it would ship as a live
    // sciencedirect.com anchor. The in-note pass is what keeps the count at 136.
    expect((result.html.match(/class="[^"]*\bin-text-citation\b/g) || [])).toHaveLength(136);

    const note = result.footnotes.find((fn) => fn.content.includes('Lenin, 1920'));
    expect(note).toBeDefined();
    expect(note.content).not.toContain('sciencedirect.com');
  }, 20_000);
});

describe('the paste ORDER is part of the contract', () => {
  it('reaches the processor with <dl class="footnote"> still intact', () => {
    // The live failure (prod 2026-09-22): handlePaste ran
    // convertDefinitionListTags on the RAW clipboard, before detection. It
    // rewrites <dt>/<dd> to <p> and deletes the <dl> — class and all — so the
    // processor queried `dl.footnote` against markup that no longer had one and
    // logged "Extracted 0 footnotes from 0 definition blocks" while all 109
    // markers were still sitting there. Every fixture test passed, because none
    // of them ran this step.
    const prepared = prepareClipboardHtml(footnoteArticle);
    const dom = document.createElement('div');
    dom.innerHTML = prepared;

    expect(dom.querySelectorAll('dl.footnote').length).toBe(110);
  });

  it('still keeps definition lists out of the stored content', async () => {
    // The conversion did not go away, it moved: it now runs on the processor's
    // OUTPUT, so a <dl> the engine did not claim is still flattened to <p>.
    const html = '<div><p>Body</p><dl><dt>Term</dt><dd>Definition</dd></dl></div>';
    const result = await run(html);

    expect(result.html).not.toContain('<dl');
    expect(result.html).not.toContain('<dd');
    expect(result.html).toContain('Definition');
  });
});
