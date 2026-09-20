/**
 * Tests for the General (catch-all) processor's reference extraction.
 *
 * Regression source: book_1788040795553 — a paste of a news article with NO
 * references section produced a fabricated "References" heading whose entries
 * were duplicated body paragraphs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GeneralProcessor } from '../../../resources/js/paste/format-processors/general-processor';

describe('GeneralProcessor.extractReferences', () => {
  let processor;

  beforeEach(() => {
    processor = new GeneralProcessor();
  });

  const domFrom = (html) => {
    const dom = document.createElement('div');
    dom.innerHTML = html;
    return dom;
  };

  describe('no reference section present', () => {
    it('extracts ZERO references from news prose containing years', async () => {
      // Clipboard HTML is always wrapper-wrapped; extraction runs before those
      // wrappers are unwrapped, which is why the old dom.children walk was blind.
      const dom = domFrom(`
        <div><div>
          <h1>The Tea Act at 250</h1>
          <p>The East India Company's directors faced something similar in 1773 when Parliament passed the Regulating Act, an early attempt at state control.</p>
          <p>Gallup found that nearly four in 10 Americans said A.I. did more harm than good, and in the first three months of 2026 organized opposition blocked 75 projects.</p>
          <p>The lesson of the East India Company is not only that corporations can behave monstrously abroad. Burke understood this in the 1780s.</p>
          <p>The most sweeping regulatory assault in the history of corporate China followed, and Mr. Ma resurfaced in February 2025.</p>
        </div></div>
      `);
      const before = dom.querySelectorAll('p').length;

      const references = await processor.extractReferences(dom, 'testBook');

      expect(references).toHaveLength(0);
      // Nothing moved, nothing removed — the body is untouched.
      expect(dom.querySelectorAll('p')).toHaveLength(before);
    });

    it('still finds a heading-less bibliography when the run is structured', async () => {
      const dom = domFrom(`
        <div>
          <p>A closing body paragraph about the commons that happens to mention 1990.</p>
          <p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.</p>
          <p>Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.</p>
          <p>Dalrymple, William. The Anarchy. London: Bloomsbury, 2019.</p>
        </div>
      `);

      const references = await processor.extractReferences(dom, 'testBook');

      expect(references).toHaveLength(3);
      expect(dom.querySelectorAll('p')).toHaveLength(1);
      expect(dom.textContent).toContain('closing body paragraph');
    });
  });

  describe('reference section present', () => {
    const withHeading = `
      <div><div>
        <h2>Introduction</h2>
        <p>Body prose discussing the commons at length, first published in 1968.</p>
        <h2>References</h2>
        <p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.</p>
        <p>Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.</p>
      </div></div>
    `;

    it('finds the heading through the clipboard wrapper divs', async () => {
      const dom = domFrom(withHeading);
      const references = await processor.extractReferences(dom, 'testBook');

      expect(references).toHaveLength(2);
      expect(references[0].originalText).toContain('Marcuse');
    });

    it('MOVES the entries out of the DOM and removes the source heading', async () => {
      const dom = domFrom(withHeading);
      await processor.extractReferences(dom, 'testBook');

      expect(dom.textContent).not.toContain('Marcuse');
      expect(dom.textContent).not.toContain('Ostrom');
      expect(dom.textContent).toContain('Body prose discussing the commons');
      const headings = Array.from(dom.querySelectorAll('h2')).map((h) => h.textContent);
      expect(headings).toEqual(['Introduction']);
    });

    it('stores an inline fragment, never a block element', async () => {
      const dom = domFrom(withHeading);
      const references = await processor.extractReferences(dom, 'testBook');

      references.forEach((ref) => {
        expect(ref.content).not.toMatch(/<p\b/i);
      });
    });

    it('leaves body prose above the heading alone', async () => {
      const dom = domFrom(withHeading);
      const references = await processor.extractReferences(dom, 'testBook');

      expect(references.some((r) => r.originalText.includes('Body prose'))).toBe(false);
    });

    it('finds a heading worded as something other than "References"', async () => {
      const dom = domFrom(`
        <div>
          <h2>7. Works Consulted</h2>
          <p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.</p>
          <p>Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.</p>
        </div>
      `);

      expect(await processor.extractReferences(dom, 'testBook')).toHaveLength(2);
    });

    it('stops at the next same-level heading', async () => {
      const dom = domFrom(`
        <div>
          <h2>References</h2>
          <p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.</p>
          <h2>Acknowledgements</h2>
          <p>Thanks to the many colleagues who read drafts of this in 2019.</p>
        </div>
      `);

      const references = await processor.extractReferences(dom, 'testBook');

      expect(references).toHaveLength(1);
      expect(dom.textContent).toContain('Thanks to the many colleagues');
    });
  });

  describe('anchor-based strategy', () => {
    it('stores innerHTML and removes the matched container', async () => {
      const dom = domFrom(`
        <div>
          <p>Body text.</p>
          <p><a name="ref1"></a>Marcuse, H. 1964. One-Dimensional Man.</p>
        </div>
      `);

      const references = await processor.extractReferences(dom, 'testBook');

      expect(references).toHaveLength(1);
      expect(references[0].content).not.toMatch(/<p\b/i);
      expect(references[0].originalAnchorId).toBe('ref1');
      expect(dom.textContent).not.toContain('Marcuse');
    });

    it('ignores an ambiguous container holding several ref anchors', async () => {
      const dom = domFrom(`
        <div>
          <p><a name="ref1"></a>First entry, 1964.<a name="ref2"></a>Second entry, 1990.</p>
        </div>
      `);

      expect(await processor.extractReferences(dom, 'testBook')).toHaveLength(0);
    });
  });
});

describe('GeneralProcessor.process — end to end', () => {
  it('emits no bibliography section for a news article, and no duplicated prose', async () => {
    const html = `
      <div><div>
        <h1>The Tea Act at 250</h1>
        <p>The East India Company's directors faced something similar in 1773 when Parliament passed the Regulating Act.</p>
        <p>Gallup found that nearly four in 10 Americans said A.I. did more harm than good in 2026.</p>
        <p>The lesson of the East India Company is not only that corporations can behave monstrously abroad. Burke understood this in the 1780s.</p>
      </div></div>
    `;

    const result = await new GeneralProcessor().process(html, 'testBook');

    expect(result.references).toHaveLength(0);
    expect(result.html).not.toContain('data-static-content="bibliography"');
    expect(result.html.match(/1773 when Parliament/g)).toHaveLength(1);
    expect(result.html.match(/Burke understood this/g)).toHaveLength(1);
  });

  it('emits each real reference exactly once, as one well-formed node', async () => {
    const html = `
      <div><div>
        <p>Body prose about the commons, and its long afterlife.</p>
        <h2>References</h2>
        <p>Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.</p>
        <p>Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.</p>
      </div></div>
    `;

    const result = await new GeneralProcessor().process(html, 'testBook');

    expect(result.references).toHaveLength(2);
    expect(result.html.match(/One-Dimensional Man/g)).toHaveLength(1);
    expect(result.html.match(/<h2[^>]*data-static-content="bibliography"/g)).toHaveLength(1);

    // No nested <p>, and no empty tagged paragraphs after a reparse — the
    // phantom-node pattern from the bug report.
    const reparsed = document.createElement('div');
    reparsed.innerHTML = result.html;
    const tagged = Array.from(reparsed.querySelectorAll('[data-static-content="bibliography"]'));
    expect(tagged).toHaveLength(3); // one h2 + two entries
    tagged.slice(1).forEach((el) => {
      expect(el.textContent.trim()).not.toBe('');
    });
  });
});

/**
 * Regression: barnett-2020 (eLife) converted with ZERO linked citations while its PDF twin linked
 * 39, and the book then failed its whole citation review with "no claims were extracted".
 *
 * eLife writes in-text citations as fully-qualified links back into its own page
 * (`https://elifesciences.org/articles/60080#bib24`) and puts the matching id one level INSIDE the
 * list item: `<li class="reference-list__item"><div class="reference" id="bib24">`. Strategy 2
 * (shape/cohort) found the reference entries correctly but discarded that id, so nothing could map
 * the body's anchors onto them — and because those citations were already <a> tags, the plain-text
 * author-year linker would not touch them either. The citations fell between the two rules.
 */
describe('GeneralProcessor publisher citation ids', () => {
  const eLifeShaped = (citationHref) => `
    <div><div>
      <p>Acronyms hinder comprehension (<a href="${citationHref}" data-behaviour-initialised="true">Sword, 2012</a>).</p>
      <h2>References</h2>
      <ul>
        <li class="reference-list__item"><div class="reference" id="bib24">
          Sword H. 2012. <i>Stylish Academic Writing</i>. Harvard University Press.
        </div></li>
        <li class="reference-list__item"><div class="reference" id="bib20">
          Pinker S. 2015. <i>The Sense of Style</i>. Penguin.
        </div></li>
      </ul>
    </div></div>
  `;

  it('recovers the entry id from a nested element when an ABSOLUTE self-referential link cites it', async () => {
    const dom = document.createElement('div');
    dom.innerHTML = eLifeShaped('https://elifesciences.org/articles/60080#bib24');

    const references = await new GeneralProcessor().extractReferences(dom, 'testBook');

    expect(references).toHaveLength(2);
    // Only bib24 is cited in the body, so only it is claimed. An uncited entry keeps the
    // generated-key path rather than inventing a mapping.
    expect(references.find((r) => /Sword/.test(r.originalText)).originalAnchorId).toBe('bib24');
    expect(references.find((r) => /Pinker/.test(r.originalText)).originalAnchorId).toBeUndefined();
  });

  it('recovers it for a BARE fragment too (the same rule serves both href shapes)', async () => {
    const dom = document.createElement('div');
    dom.innerHTML = eLifeShaped('#bib24');

    const references = await new GeneralProcessor().extractReferences(dom, 'testBook');

    expect(references.find((r) => /Sword/.test(r.originalText)).originalAnchorId).toBe('bib24');
  });

  it('claims NOTHING when the cited id is not a reference target', async () => {
    // A link out to another site that happens to carry a fragment must never be read as a
    // citation mapping, and an id nothing cites must not be claimed.
    const dom = document.createElement('div');
    dom.innerHTML = `
      <div><div>
        <p>See the <a href="https://example.com/guide#section-3">style guide</a>.</p>
        <h2>References</h2>
        <ul>
          <li class="reference-list__item"><div class="reference" id="bib24">
            Sword H. 2012. <i>Stylish Academic Writing</i>. Harvard University Press.
          </div></li>
          <li class="reference-list__item"><div class="reference" id="bib20">
            Pinker S. 2015. <i>The Sense of Style</i>. Penguin.
          </div></li>
        </ul>
      </div></div>
    `;

    const references = await new GeneralProcessor().extractReferences(dom, 'testBook');

    expect(references).toHaveLength(2);
    references.forEach((r) => expect(r.originalAnchorId).toBeUndefined());
  });

  it('does NOT claim an id whose link text is PROSE, not a citation marker', async () => {
    // Regression, caught by the web-xanadu-layout-table fixture rather than by reasoning: the ACM
    // Xanadu page links the words "permissions statement" to `#permissions-statement`, whose anchor
    // sits inside a block the cohort detector accepts as reference-like. "A link into the reference
    // list" is NOT the same as "a citation" — claiming it turned an ordinary cross-reference into a
    // citation pointing at a bibliography entry.
    const dom = document.createElement('div');
    dom.innerHTML = `
      <div><div>
        <p>Reproduced under the <a href="https://cs.brown.edu/papers/60.html#permissions-statement">permissions statement</a>.</p>
        <h2>References</h2>
        <ul>
          <li class="reference-list__item"><div class="reference" id="permissions-statement">
            Nelson T. 1997. <i>Xanadu Permissions</i>. Keio University Press.
          </div></li>
          <li class="reference-list__item"><div class="reference" id="bib20">
            Pinker S. 2015. <i>The Sense of Style</i>. Penguin.
          </div></li>
        </ul>
      </div></div>
    `;

    const references = await new GeneralProcessor().extractReferences(dom, 'testBook');

    references.forEach((r) => expect(r.originalAnchorId).toBeUndefined());
  });

  it('accepts a BARE NUMERIC marker, which is a citation shape', async () => {
    const dom = document.createElement('div');
    dom.innerHTML = `
      <div><div>
        <p>Comparisons are strained <a href="#ref-1">[1]</a>.</p>
        <h2>References</h2>
        <p id="ref-1">Charmes, Jacques. "The Informal Economy Worldwide." Margin 6, no. 2 (2012): 103-132.</p>
        <p id="ref-2">Hussmanns, Ralf. Measuring the Informal Economy. Geneva: ILO, 2004.</p>
      </div></div>
    `;

    const references = await new GeneralProcessor().extractReferences(dom, 'testBook');

    expect(references.find((r) => /Charmes/.test(r.originalText)).originalAnchorId).toBe('ref-1');
    expect(references.find((r) => /Hussmanns/.test(r.originalText)).originalAnchorId).toBeUndefined();
  });

  it('refuses an AMBIGUOUS entry offering two cited ids rather than guessing', async () => {
    // One wrong mapping attributes a claim to the wrong work — worse than an unlinked citation,
    // because it looks resolved.
    const dom = document.createElement('div');
    dom.innerHTML = `
      <div><div>
        <p>Both (<a href="#bib24">Sword, 2012</a>; <a href="#bib25">Sword, 2013</a>).</p>
        <h2>References</h2>
        <ul>
          <li class="reference-list__item">
            <div class="reference" id="bib24">Sword H. 2012. <i>Stylish Academic Writing</i>. Harvard University Press.</div>
            <div class="reference" id="bib25">Sword H. 2013. <i>Air &amp; Light &amp; Time</i>. Harvard University Press.</div>
          </li>
          <li class="reference-list__item"><div class="reference" id="bib20">
            Pinker S. 2015. <i>The Sense of Style</i>. Penguin.
          </div></li>
        </ul>
      </div></div>
    `;

    const references = await new GeneralProcessor().extractReferences(dom, 'testBook');

    const merged = references.find((r) => /Sword/.test(r.originalText));
    expect(merged).toBeDefined();
    expect(merged.originalAnchorId).toBeUndefined();
  });
});

/**
 * Screen-reader-only text must never become content — and a URL is where it does real damage.
 *
 * Taylor & Francis wraps every outbound link in
 *   <span class="off-screen" style="position:absolute;left:-9999px">(open in a new window)</span>
 * which is invisible on the page and gets glued onto the href when flattened. Measured on
 * nicholls-nieo-paste (2026-09-20): 22 of 34 reference URLs unusable, so the citation resolver
 * could not FETCH those sources and fell back to matching bibliographic metadata — Nkrumah's
 * "Neo-Colonialism", whose full text is free on marxists.org, was matched to an OpenLibrary record
 * and judged on its TITLE ALONE ("the title does not suggest support for free trade").
 */
describe('GeneralProcessor hidden text and mangled URLs', () => {
  it('strips screen-reader-only text so it cannot glue onto a URL', async () => {
    const dom = document.createElement('div');
    dom.innerHTML =
      '<p>Nkrumah, Kwame. 1965. <i>Neo-Colonialism</i>. '
      + '<a href="https://www.marxists.org/nkrumah/neo-colonialism/">'
      + 'https://www.marxists.org/nkrumah/neo-colonialism/'
      + '<span class="off-screen">(open in a new window)</span></a>.</p>';

    new GeneralProcessor().normalize(dom);

    expect(dom.textContent).not.toContain('open in a new window');
    expect(dom.textContent).toContain('https://www.marxists.org/nkrumah/neo-colonialism/');
  });

  it('strips the other common names for visually-hidden text', async () => {
    const dom = document.createElement('div');
    dom.innerHTML =
      '<p>A<span class="sr-only">SR</span>'
      + '<span class="visually-hidden">VH</span>'
      + '<span class="screen-reader-text">SRT</span>B</p>';

    new GeneralProcessor().normalize(dom);

    expect(dom.textContent.replace(/\s+/g, '')).toBe('AB');
  });

  it('removes thin spaces a typesetter put INSIDE a URL, in href and plain text', () => {
    const p = new GeneralProcessor();
    const html =
      '<a href="https://digitallibrary.un.org/record/696640?ln = en">x</a>'
      + ' and plain https://digitallibrary.un.org/record/218451?ln = en.';

    const out = p.repairTypographicUrls(html);

    expect(out).toContain('record/696640?ln=en');
    expect(out).toContain('record/218451?ln=en');
    expect(out).not.toMatch(/[ -‍ ⁠﻿]/);
  });

  it('removes PERCENT-ENCODED thin spaces too (the EPUB spelling)', () => {
    const out = new GeneralProcessor()
      .repairTypographicUrls('<a href="https://un.org/r/1?ln%E2%80%89=%E2%80%89en">x</a>');

    expect(out).toContain('https://un.org/r/1?ln=en');
  });

  it('leaves an ORDINARY space as a URL boundary, and clean markup untouched', () => {
    // The distinction the repair rests on: a normal space really does end a URL, so swallowing it
    // would drag the next words of the bibliography entry into the link.
    const p = new GeneralProcessor();
    const html = '<p>See https://example.com/a?b=c then more words here.</p>';

    expect(p.repairTypographicUrls(html)).toBe(html);
  });
});
