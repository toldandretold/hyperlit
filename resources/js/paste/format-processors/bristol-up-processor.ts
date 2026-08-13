/**
 * Bristol University Press Digital processor (bristoluniversitypressdigital.com)
 *
 * The platform behind Bristol UP's journals — including the diamond-OA Global Social Challenges
 * Journal, the first target of the systematic journal harvest (docs/journal-harvest.md). NOT
 * Silverchair despite the superficial resemblance to MIT Press/OUP: no reveal-id, no
 * data-content-id, no data-modal-source-id.
 *
 * What the markup actually gives us:
 *  - `#articleBody` wraps the article and NOTHING else. The surrounding page is ~95% furniture
 *    (Content Metrics, Altmetrics, journal nav, volume lists, cookie banner); scoping to this
 *    container removes all of it in one move rather than blacklisting each widget.
 *  - Body sections are `div.section` with real `<h2>` headings — Introduction / Conflict of
 *    interest / References all present, which is exactly what Mistral OCR loses on the PDF of
 *    the same article (it dropped two of them from its output entirely).
 *  - References: `section.refSection` → `li` → `div.reference[id^="CIT"]`, display text in
 *    `p.citationText`. Each entry ALSO carries a hidden `div.debug` holding a `<mixed-citation>`
 *    structured copy, inside a `ul.citationActions` with Google Scholar / Export Citation links.
 *    Left in place, that hidden copy is what made every reference appear twice in the imported
 *    book, so both are stripped.
 *  - In-text citations are `<a id="ref_CIT0026" href="#CIT0026">Mahony and Endfield, 2018</a>` —
 *    an exact id pointing at the reference, so linking needs no author-year guessing.
 *
 * Typed rather than `: any`-threaded (the `resources/js/paste` any-ratchet), and silent: the
 * console ratchet covers this folder too, and this module also runs under raw Node in the
 * backend citation vacuum.
 */

import { BaseFormatProcessor } from './base-processor';
import { unwrapContainers } from '../utils/transform-helpers';
import { createFootnoteSupElement } from '../utils/footnote-linker';

interface BristolReference {
  content: string;
  originalText: string;
  type: string;
  needsKeyGeneration: boolean;
  referenceId: string;
  refKeys: string[];
  originalAnchorId: string;
}

interface ExtractedFootnote {
  originalIdentifier: string;
  refId: string;
}

export class BristolUPProcessor extends BaseFormatProcessor {
  [key: string]: unknown;

  constructor() {
    super('bristol-up');
  }

  /**
   * Footnote definitions. GSCJ articles carry none, so this is written defensively against the
   * platform's note markup and simply yields nothing when a paper has no notes.
   */
  async extractFootnotes(dom: HTMLElement, bookId: string): Promise<ExtractedFootnote[]> {
    const footnotes: ExtractedFootnote[] = [];
    const els = dom.querySelectorAll<HTMLElement>(
      'div.footnote[id^="FN"], li.footnote[id^="FN"], .fnSection .footnote',
    );

    els.forEach((element) => {
      const m = (element.getAttribute('id') || '').match(/FN0*(\d+)/i);
      if (!m) return;

      // Table/figure notes belong with their block, not the document's note list.
      if (element.closest('table, figure, .table-wrap, .fig')) return;

      const identifier = parseInt(m[1] ?? '', 10).toString();
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.label, .fn-label, a[href^="#ref_FN"]').forEach((el) => el.remove());
      clone.querySelectorAll<HTMLElement>('[style]').forEach((el) => el.removeAttribute('style'));

      const html = clone.innerHTML.trim();
      if (!html) return;

      const footnoteId = this.generateFootnoteId(bookId, identifier);
      footnotes.push(this.createFootnote(
        footnoteId,
        html,
        identifier,
        this.generateFootnoteRefId(footnoteId),
        'bristol-up',
      ) as ExtractedFootnote);
      element.remove();
    });

    return footnotes;
  }

  /** In-text note refs: <a href="#FN0001">. Map to the app's <sup fn-count-id> form. */
  linkFootnotes(dom: HTMLElement, footnotes: ExtractedFootnote[]): void {
    if (!footnotes || footnotes.length === 0) return;

    dom.querySelectorAll<HTMLAnchorElement>('a[href^="#FN"]').forEach((link) => {
      const m = (link.getAttribute('href') || '').match(/#FN0*(\d+)/i);
      if (!m) return;
      const identifier = parseInt(m[1] ?? '', 10).toString();
      const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
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
   * References: `div.reference[id^="CIT"]`, clean text in `p.citationText`.
   * referenceId IS the CIT id, so the in-text `href="#CIT0026"` anchors map exactly.
   */
  async extractReferences(dom: HTMLElement, bookId: string): Promise<BristolReference[]> {
    const references: BristolReference[] = [];
    const seen = new Set<string>();

    dom.querySelectorAll<HTMLElement>('.reference[id^="CIT"]').forEach((item) => {
      const citId = item.getAttribute('id');
      if (!citId || seen.has(citId)) return;

      // p.citationText is the human-readable citation; the sibling debug/actions blocks hold a
      // hidden duplicate + export chrome and must never reach the bibliography.
      const citation = item.querySelector('p.citationText');
      if (!citation) return;
      const clone = citation.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.debug, .citationActions, a.googleScholar, a.exportCitation')
        .forEach((el) => el.remove());

      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 10) return;

      seen.add(citId);
      references.push({
        content: clone.innerHTML.trim() || text,
        originalText: text,
        type: 'bristol-up-bibliography',
        needsKeyGeneration: false,
        referenceId: citId,
        refKeys: [citId],
        originalAnchorId: citId,
      });
    });

    return references;
  }

  /** In-text citations: <a href="#CIT0026"> — exact id, so link directly. */
  linkCitations(dom: HTMLElement, references: BristolReference[]): void {
    super.linkCitations(dom, references);

    const refIds = new Set((references || []).map((r) => r.referenceId));

    dom.querySelectorAll<HTMLAnchorElement>('a[href^="#CIT"]').forEach((link) => {
      const citId = (link.getAttribute('href') || '').slice(1);
      if (!refIds.has(citId)) return;

      link.setAttribute('href', `#${citId}`);
      link.setAttribute('class', 'in-text-citation');
      ['id', 'onclick', 'target', 'title', 'data-popover-anchor']
        .forEach((attr) => link.removeAttribute(attr));
      link.removeAttribute('style');
    });
  }

  /**
   * The article's front matter — title, authors, affiliation, abstract, keywords — sits OUTSIDE
   * `#articleBody`, in the page's metadata card ABOVE it. Scoping to the body therefore threw all
   * of it away and the book opened cold on "Key messages" (the PDF lane, which sees the printed
   * page, keeps it). So it is rebuilt here from the header markup and prepended.
   *
   * Deliberately unlabelled — no "Abstract" heading — because the printed article presents it as
   * the opening paragraph, and the two lanes are meant to be compared side by side.
   */
  buildArticleHeader(dom: HTMLElement): string {
    const box = document.createElement('div');

    const titleEl = dom.querySelector<HTMLElement>(
      '[data-testid="block-title"] h1, [data-testid="block-title"] h2, [data-testid="block-title"] .title',
    );
    const title = titleEl?.textContent?.trim();
    if (title) {
      const h1 = document.createElement('h1');
      h1.textContent = title;
      box.appendChild(h1);
    }

    // The author name appears twice per contributor — once on the trigger link, once inside the
    // hidden affiliation pop-up — so read only the trigger and dedupe.
    const authors: string[] = [];
    dom.querySelectorAll<HTMLElement>('[data-testid="author-name"]').forEach((el) => {
      const name = el.textContent?.trim();
      if (name && !authors.includes(name)) authors.push(name);
    });
    if (authors.length) {
      const p = document.createElement('p');
      p.textContent = authors.join(', ');
      box.appendChild(p);
    }

    // Affiliations live in those pop-ups: institution + country, one per contributor and usually
    // shared, so dedupe rather than repeating "University of Sussex, UK" per author.
    const affiliations: string[] = [];
    dom.querySelectorAll<HTMLElement>('.contributor-details-pop-up-affiliation').forEach((el) => {
      const institution = el.querySelector<HTMLElement>('.institution')?.textContent?.trim() ?? '';
      const country = el.querySelector<HTMLElement>('.country')?.textContent?.trim() ?? '';
      const affiliation = [institution, country].filter(Boolean).join(', ');
      if (affiliation && !affiliations.includes(affiliation)) affiliations.push(affiliation);
    });
    for (const affiliation of affiliations) {
      const p = document.createElement('p');
      p.textContent = affiliation;
      box.appendChild(p);
    }

    // The platform renders the abstract twice (responsive duplicates of the same block); taking
    // the first is what stops it appearing twice in the imported book.
    const abstract = dom.querySelector<HTMLElement>('section.abstract, .abstract_or_excerpt section');
    if (abstract) {
      const clone = abstract.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.counterData, script, style').forEach((el) => el.remove());
      const paragraphs = clone.querySelectorAll<HTMLElement>('p');
      if (paragraphs.length) {
        paragraphs.forEach((p) => box.appendChild(p.cloneNode(true)));
      } else {
        const text = clone.textContent?.trim();
        if (text) {
          const p = document.createElement('p');
          p.textContent = text;
          box.appendChild(p);
        }
      }
    }

    const keywords = dom.querySelector<HTMLElement>('dd.keywords')?.textContent
      ?.replace(/\s+/g, ' ').trim();
    if (keywords) {
      const p = document.createElement('p');
      p.textContent = `Key words: ${keywords}`;
      box.appendChild(p);
    }

    return box.innerHTML;
  }

  /**
   * Scope to `#articleBody` — re-attaching the front matter that lives above it — and strip the
   * reference block (the base class re-appends references cleanly) plus the hidden
   * structured-citation duplicates and export widgets.
   */
  async transformStructure(dom: HTMLElement, bookId: string): Promise<void> {
    const header = this.buildArticleHeader(dom);
    const article = dom.querySelector('#articleBody, .articleBody');
    if (article) {
      // Everything outside the article container is page furniture. Replacing wholesale is
      // deliberate: the surrounding widgets are re-skinned often, and a blacklist of them rots.
      dom.innerHTML = header + article.innerHTML;
    } else if (header) {
      dom.insertAdjacentHTML('afterbegin', header);
    }

    dom.querySelectorAll(
      '.refSection, .content-references-list, .citationActions, .debug, ' +
      'a.googleScholar, a.exportCitation, .c-IconButton, [data-popover], [role="tooltip"]',
    ).forEach((el) => el.remove());

    // Buttons are pure interaction chrome (Export References, select-all checkboxes).
    dom.querySelectorAll('button').forEach((el) => el.remove());

    unwrapContainers(dom);
  }
}
