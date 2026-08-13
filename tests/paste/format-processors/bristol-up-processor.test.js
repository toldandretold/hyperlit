/**
 * Bristol University Press Digital processor.
 *
 * The platform behind the diamond-OA journals the systematic harvest targets first
 * (docs/journal-harvest.md). Fixtures here are hand-built minimal reproductions of the four
 * structural traits that made the SERVER-fetched page convert badly before this processor
 * existed — it was mis-detected as `sage` on a generic `[role="listitem"]` match:
 *
 *   1. `#articleBody` wraps the article; the rest of the page is furniture (Content Metrics,
 *      Altmetrics, journal nav, volume lists) that was landing in the imported book.
 *   2. Every reference carries a HIDDEN `div.debug` holding a `<mixed-citation>` structured
 *      copy — that duplicate is why each reference appeared twice.
 *   3. `ul.citationActions` adds Google Scholar / Export Citation links inside each reference.
 *   4. In-text citations are `<a href="#CIT0026">`, an exact id, so linking needs no
 *      author-year guessing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BristolUPProcessor } from '../../../resources/js/paste/format-processors/bristol-up-processor';
import { detectFormat } from '../../../resources/js/paste/format-detection/format-detector';

/** A minimal page in the platform's real shape: article + surrounding furniture. */
const PAGE = `
  <div id="pageBody">
    <div class="component component-content-item">Cookie banner and journal navigation</div>

    <!-- Front matter: ABOVE #articleBody, which is why scoping to the body lost it. -->
    <div data-testid="block-title">
      <h2 class="typography-body title">More than a metaphor: &lsquo;climate colonialism&rsquo; in perspective</h2>
    </div>
    <div class="contributor-details"><div class="contributor-details-block">
      <span data-testid="author-name" class="contributor-details-link" id="authorAffiliate">Gurminder K. Bhambra</span>
      <div class="contributor-details-pop-up visibility-hidden" id="authorAffiliatePopUp">
        <span class="contributor-details-pop-up-name">Gurminder K. Bhambra</span>
        <span class="contributor-details-pop-up-affiliation"><span class="institution">University of Sussex</span><span class="text">, </span><span class="country">UK</span></span>
      </div>
    </div></div>
    <div class="contributor-details"><div class="contributor-details-block">
      <span data-testid="author-name" class="contributor-details-link" id="authorAffiliate_0">Peter Newell</span>
      <div class="contributor-details-pop-up visibility-hidden" id="authorAffiliatePopUp_0">
        <span class="contributor-details-pop-up-name">Peter Newell</span>
        <span class="contributor-details-pop-up-affiliation"><span class="institution">University of Sussex</span><span class="text">, </span><span class="country">UK</span></span>
      </div>
    </div></div>
    <!-- The platform emits the abstract block TWICE (responsive duplicates). -->
    <div class="component component-content-summary abstract_or_excerpt">
      <div class="counterData"></div>
      <section class="abstract"><p>In early 2022, over 30 years after the IPCC released its first report, the word &lsquo;colonialism&rsquo; finally entered its official lexicon.</p></section>
    </div>
    <div class="component component-content-summary abstract_or_excerpt">
      <div class="counterData"></div>
      <section class="abstract"><p>In early 2022, over 30 years after the IPCC released its first report, the word &lsquo;colonialism&rsquo; finally entered its official lexicon.</p></section>
    </div>
    <dl class="keywords c-List__items">
      <dt class="keywords inline">Keywords:</dt>
      <dd class="keywords inline"><a href="/gsc/search?q=x">climate change</a>; <a href="/gsc/search?q=y">colonialism</a></dd>
    </dl>

    <div id="articleBody">
      <div class="section" id="s1"><h2>Introduction</h2>
        <p>The language of colonialism is invoked
          (<a id="ref_CIT0026" href="#CIT0026">Mahony and Endfield, 2018</a>) here.</p>
      </div>
      <div class="section" id="s5"><h2>Conflict of interest</h2>
        <p>The author declares that there is no conflict of interest.</p>
      </div>
      <section class="refSection level1"><h2>References</h2>
        <ul class="refList no-enumerators">
          <li><div id="CIT0026" class="reference">
            <p class="citationText text-body1">Mahony, M. and Endfield, G. (2018) Climate and colonialism, <i>WIREs: Climate Change</i>, 9(2): art e510.</p>
            <ul class="citationActions">
              <div class="debug" style="display: none"><mixed-citation publication-type="journal"><surname>Mahony</surname>, <given-names>M.</given-names></mixed-citation></div>
              <li><a class="googleScholar" href="http://scholar.google.com/x">Search Google Scholar</a></li>
              <li><a class="exportCitation" href="/gsc/exportcitation?cid=CIT0026">Export Citation</a></li>
            </ul>
          </div></li>
        </ul>
      </section>
    </div>
    <div class="component component-content-item"><h2>Content Metrics</h2><p>Full Text Views 70501</p></div>
  </div>
`;

function domFrom(html) {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return dom;
}

describe('BristolUPProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new BristolUPProcessor();
  });

  it('is detected ahead of the generic sage match', () => {
    expect(detectFormat(PAGE)).toBe('bristol-up');
  });

  describe('extractReferences', () => {
    it('extracts one clean entry per CIT id, keyed for exact in-text linking', async () => {
      const refs = await processor.extractReferences(domFrom(PAGE), 'testBook');

      expect(refs).toHaveLength(1);
      expect(refs[0].referenceId).toBe('CIT0026');
      expect(refs[0].originalText).toContain('Mahony, M. and Endfield, G. (2018)');
      expect(refs[0].type).toBe('bristol-up-bibliography');
    });

    it('drops the hidden mixed-citation duplicate and the export chrome', async () => {
      const refs = await processor.extractReferences(domFrom(PAGE), 'testBook');
      const text = refs[0].originalText + refs[0].content;

      expect(text).not.toContain('mixed-citation');
      expect(text).not.toContain('Search Google Scholar');
      expect(text).not.toContain('Export Citation');
      // The structured copy repeats the surname; the clean citation names it once.
      expect(refs[0].originalText.match(/Mahony/g)).toHaveLength(1);
    });
  });

  describe('transformStructure', () => {
    it('scopes the body to #articleBody, discarding page furniture', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');
      const text = dom.textContent;

      expect(text).toContain('The language of colonialism is invoked');
      expect(text).toContain('no conflict of interest');
      expect(text).not.toContain('Content Metrics');
      expect(text).not.toContain('Cookie banner and journal navigation');
    });

    it('removes the raw reference section (the base class re-appends it cleanly)', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');

      expect(dom.querySelector('.refSection')).toBeNull();
      expect(dom.textContent).not.toContain('Search Google Scholar');
    });

    // The front matter sits ABOVE #articleBody, so scoping to the body silently dropped the
    // title, authors and abstract and the book opened cold on "Key messages".
    it('re-attaches the title, authors, affiliation, abstract and keywords', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');
      const text = dom.textContent;

      expect(dom.querySelector('h1')?.textContent.trim())
        .toBe('More than a metaphor: ‘climate colonialism’ in perspective');
      expect(text).toContain('Gurminder K. Bhambra, Peter Newell');
      expect(text).toContain('University of Sussex, UK');
      expect(text).toContain('the word ‘colonialism’ finally entered its official lexicon');
      expect(text).toContain('Key words: climate change; colonialism');
    });

    it('puts the front matter BEFORE the body, not after it', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');
      const text = dom.textContent;

      expect(text.indexOf('More than a metaphor')).toBeLessThan(text.indexOf('Introduction'));
    });

    it('takes the abstract once, despite the platform emitting it twice', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');
      const hits = dom.textContent.match(/finally entered its official lexicon/g);

      expect(hits).toHaveLength(1);
    });

    it('names each author once, not twice via the hidden affiliation pop-up', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');

      expect(dom.textContent.match(/Gurminder K\. Bhambra/g)).toHaveLength(1);
      // One shared affiliation, not one per author.
      expect(dom.textContent.match(/University of Sussex, UK/g)).toHaveLength(1);
    });

    it('keeps the section headings OCR loses on the PDF of the same article', async () => {
      const dom = domFrom(PAGE);
      await processor.transformStructure(dom, 'testBook');
      const headings = [...dom.querySelectorAll('h2')].map(h => h.textContent.trim());

      expect(headings).toContain('Introduction');
      expect(headings).toContain('Conflict of interest');
    });
  });

  describe('linkCitations', () => {
    it('links an in-text anchor straight to its reference id', async () => {
      const dom = domFrom(PAGE);
      const refs = await processor.extractReferences(dom, 'testBook');
      processor.linkCitations(dom, refs);

      const link = dom.querySelector('a[href="#CIT0026"]');
      expect(link).not.toBeNull();
      expect(link.getAttribute('class')).toBe('in-text-citation');
      expect(link.textContent).toBe('Mahony and Endfield, 2018');
    });

    it('leaves anchors with no matching reference alone', async () => {
      const dom = domFrom('<p><a href="#CIT9999">Ghost, 1999</a></p>');
      processor.linkCitations(dom, []);

      expect(dom.querySelector('a.in-text-citation')).toBeNull();
    });
  });
});
