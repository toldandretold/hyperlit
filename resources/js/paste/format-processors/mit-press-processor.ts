/**
 * MIT Press Processor (direct.mit.edu — Silverchair platform)
 *
 * Close cousin of the OUP processor (same platform), with three differences:
 *  - References live in [data-content-id^="bib"], text in .citation.mixed-citation
 *  - In-text citations are <a data-modal-source-id="bibN"> pointing DIRECTLY at
 *    the reference id — so linking is exact (no author-year guessing).
 *  - Footnote definitions are .fn[content-id^="fn"]; in-text footnote refs use
 *    the same reveal-id / data-open anchors OUP uses.
 */

import { BaseFormatProcessor } from './base-processor';
import { isReferenceSectionHeading } from '../utils/dom-utils';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements,
} from '../utils/transform-helpers';
import { createFootnoteSupElement } from '../utils/footnote-linker';

export class MitPressProcessor extends BaseFormatProcessor {
  [key: string]: any;
  constructor() {
    super('mit-press');
  }

  /**
   * Footnote definitions: <div class="fn" content-id="fn1" id="fn1">.
   */
  async extractFootnotes(dom: any, bookId: any) {
    const footnotes: any[] = [];
    const els = dom.querySelectorAll('.fn[content-id^="fn"], div[content-id^="fn"]');

    els.forEach((element: any) => {
      const contentId = element.getAttribute('content-id');

      // Leave table/figure notes in the body.
      if (element.closest('.table-wrap-foot, .table-wrap, table, .fig, figure')) return;

      const m = contentId.match(/fn-?(\d+)/);
      if (!m) return;
      const identifier = parseInt(m[1], 10).toString();

      const clone = element.cloneNode(true);
      // Drop label/back-link chrome.
      clone.querySelectorAll('.label, .fn-label, .end-note-link, a[href*="#fn"]').forEach((el: any) => el.remove());
      clone.querySelectorAll('[style]').forEach((el: any) => el.removeAttribute('style'));

      const html = clone.innerHTML.trim();
      if (!html) return;

      const footnote = this.createFootnote(
        this.generateFootnoteId(bookId, identifier),
        html,
        identifier,
        this.generateFootnoteRefId(this.generateFootnoteId(bookId, identifier)),
        'mit-press',
      );
      (footnote as any).contentId = contentId;
      footnotes.push(footnote);
      element.remove();
    });

    return footnotes;
  }

  /**
   * In-text footnote refs: <a reveal-id="fn1" data-open="fn1" class="xref-fn">.
   * Identical to OUP — map to clean <sup fn-count-id>.
   */
  linkFootnotes(dom: any, footnotes: any) {
    const links = dom.querySelectorAll('a[reveal-id^="fn"], a[data-open^="fn"]');
    links.forEach((link: any) => {
      const revealId = link.getAttribute('reveal-id') || link.getAttribute('data-open');
      const m = revealId.match(/fn-?(\d+)/);
      if (!m) return;
      const identifier = parseInt(m[1], 10).toString();
      const footnote = footnotes.find((fn: any) => fn.originalIdentifier === identifier);
      if (!footnote) return;

      const newSup = createFootnoteSupElement(footnote.refId, identifier);
      const parentSup = link.parentElement;
      if (parentSup && parentSup.tagName === 'SUP') {
        parentSup.replaceWith(newSup);
      } else {
        link.replaceWith(newSup);
      }
    });
  }

  /**
   * Reference definitions: [data-content-id^="bib"], text in .citation.
   * referenceId = the bib id itself (e.g. "bib1") so in-text
   * data-modal-source-id="bib1" links exactly.
   */
  async extractReferences(dom: any, bookId: any) {
    const references: any[] = [];
    const items = dom.querySelectorAll('[data-content-id^="bib"]');

    items.forEach((item: any) => {
      const bibId = item.getAttribute('data-content-id'); // "bib1"
      const citation = item.querySelector('.citation, .mixed-citation') || item;
      const text = citation.textContent.replace(/\s+/g, ' ').trim();
      if (!text || text.length < 10) return;

      references.push({
        content: text,
        originalText: text,
        type: 'mit-press-bibliography',
        needsKeyGeneration: false,
        referenceId: bibId,
        refKeys: [bibId],
        contentId: bibId,
      });
    });

    return references;
  }

  /**
   * In-text citations: <a data-modal-source-id="bibN" class="xref-bibr">.
   * Direct, exact mapping — set href + class, keep the visible text.
   */
  linkCitations(dom: any, references: any) {
    super.linkCitations(dom, references); // builds mappings (no-op for exact-id refs)

    const refIds = new Set(references.map((r: any) => r.referenceId));
    const links = dom.querySelectorAll('a[data-modal-source-id^="bib"]');
    let linked = 0;

    links.forEach((link: any) => {
      const bibId = link.getAttribute('data-modal-source-id');
      if (!refIds.has(bibId)) return;

      link.setAttribute('href', `#${bibId}`);
      link.setAttribute('class', 'in-text-citation');
      ['data-modal-source-id', 'reveal-id', 'data-open', 'data-google-interstitial'].forEach((a: any) => link.removeAttribute(a));
      link.removeAttribute('style');
      linked++;
    });

    console.log(`📚 MIT Press: linked ${linked} in-text citations`);
  }

  /**
   * Strip MIT chrome + remove the original reference/footnote sections (they're
   * re-appended cleanly), then general unwrapping.
   */
  async transformStructure(dom: any, bookId: any) {
    removeSectionsByHeading(dom, isReferenceSectionHeading);
    removeStaticContentElements(dom);

    // NB: do NOT remove .split-view-modal here — the in-text footnote/citation
    // anchors themselves carry that class (it's the modal-trigger hook), and
    // linkFootnotes/linkCitations still need them in Stage 7.
    dom.querySelectorAll(
      '.stats-get-citation, .toolbar, .citation-tools, .article-tools, .js-view-large, ' +
      '.download-slide, .table-modal',
    ).forEach((el: any) => el.remove());

    unwrapContainers(dom);
  }
}
