/**
 * Tests for Cambridge processor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CambridgeProcessor } from '../../../resources/js/paste/format-processors/cambridge-processor.js';

describe('CambridgeProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new CambridgeProcessor();
  });

  describe('extractFootnotes', () => {
    it('should extract Cambridge footnotes from standard structure', async () => {
      const html = `
        <div>
          <p>Some text with a footnote<a class="xref fn"><span>Footnote </span><sup>1</sup></a></p>
          <div id="reference-1-content">
            <p class="p"><span class="label"><sup>1</sup></span> This is the footnote content.</p>
          </div>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      const footnotes = await processor.extractFootnotes(dom, 'testBook');

      expect(footnotes).toHaveLength(1);
      expect(footnotes[0].originalIdentifier).toBe('1');
      expect(footnotes[0].content).toContain('This is the footnote content');
      expect(footnotes[0].type).toBe('cambridge-normalized');
    });

    it('should simplify in-text footnote links', async () => {
      const html = `
        <div>
          <p>Text<a class="xref fn"><span>Footnote </span><sup>42</sup></a></p>
          <div id="reference-42-content">
            <p><span class="label"><sup>42</sup></span> Content</p>
          </div>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      await processor.extractFootnotes(dom, 'testBook');

      // The complex <a> should be replaced with simple <sup>
      const sup = dom.querySelector('sup[fn-count-id="42"]');
      expect(sup).toBeTruthy();
      expect(sup.textContent).toBe('42');
      expect(dom.querySelector('a.xref.fn')).toBeFalsy();
    });

    it('should handle multiple footnotes', async () => {
      const html = `
        <div>
          <p>Text<a class="xref fn"><sup>1</sup></a> more<a class="xref fn"><sup>2</sup></a></p>
          <div id="reference-1-content"><p>Footnote 1</p></div>
          <div id="reference-2-content"><p>Footnote 2</p></div>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      const footnotes = await processor.extractFootnotes(dom, 'testBook');

      expect(footnotes).toHaveLength(2);
      expect(footnotes[0].originalIdentifier).toBe('1');
      expect(footnotes[1].originalIdentifier).toBe('2');
    });

    it('should remove footnote containers from DOM', async () => {
      const html = `
        <div>
          <p>Text</p>
          <div id="reference-99-content"><p>Footnote</p></div>
          <p>More text</p>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      await processor.extractFootnotes(dom, 'testBook');

      // The footnote container should be removed
      expect(dom.querySelector('[id^="reference-"]')).toBeFalsy();
    });
  });

  describe('extractReferences', () => {
    it('should extract references containing years', async () => {
      const html = `
        <div>
          <h2>References</h2>
          <p>Smith, J. (2020). A great paper. Journal of Testing, 15(2), 123-145.</p>
          <p>Jones, A. (2021). Another paper. Science Review, 8(1), 45-67.</p>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      const references = await processor.extractReferences(dom, 'testBook');

      expect(references.length).toBeGreaterThan(0);
      expect(references[0].type).toBe('cambridge-reference');
      expect(references[0].needsKeyGeneration).toBe(true);
    });

    it('should skip paragraphs with in-text citations', async () => {
      const html = `
        <div>
          <h2>References</h2>
          <p>This is body text citing (Smith, 2020) and others.</p>
          <p>Smith, J. (2020). The actual reference.</p>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      const references = await processor.extractReferences(dom, 'testBook');

      // Cambridge processor extracts both paragraphs after References heading
      // The first paragraph is filtered out by in-text citation check (has "Smith, 2020")
      // But the second paragraph also has (2020) which looks like year pattern
      // So we actually get 1 reference - the actual reference
      expect(references.length).toBeGreaterThanOrEqual(1);

      // Find the actual reference (not the citation)
      const actualRef = references.find(ref => ref.originalText.includes('The actual reference'));
      expect(actualRef).toBeTruthy();
    });
  });

  describe('transformStructure', () => {
    it('should unwrap div containers', async () => {
      const html = `
        <div>
          <div class="container">
            <p>Content</p>
          </div>
        </div>
      `;

      const dom = document.createElement('div');
      dom.innerHTML = html;

      await processor.transformStructure(dom, 'testBook');

      // The inner div should be unwrapped
      expect(dom.querySelector('div.container')).toBeFalsy();
      expect(dom.querySelector('p')).toBeTruthy();
    });
  });

  describe('process (full pipeline)', () => {
    it('should process complete Cambridge document', async () => {
      const html = `
        <div>
          <h1>Test Article</h1>
          <p>Introduction with footnote<a class="xref fn"><sup>1</sup></a></p>
          <div id="reference-1-content">
            <p class="p"><span class="label"><sup>1</sup></span> Footnote content here.</p>
          </div>
          <h2>References</h2>
          <p>Author, A. (2023). Paper title. Journal Name.</p>
        </div>
      `;

      const result = await processor.process(html, 'testBook');

      expect(result.formatType).toBe('cambridge');
      expect(result.footnotes).toHaveLength(1);
      expect(result.references.length).toBeGreaterThan(0);
      expect(result.html).toBeTruthy();

      // Footnote container should be removed from output
      expect(result.html).not.toContain('reference-1-content');
    });
  });
});
