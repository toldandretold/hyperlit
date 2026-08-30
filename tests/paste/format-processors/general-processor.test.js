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
