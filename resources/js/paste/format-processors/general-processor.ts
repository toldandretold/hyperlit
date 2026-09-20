/**
 * General Format Processor
 * Fallback processor for unrecognized formats
 * Uses heuristic-based extraction with minimal assumptions about structure
 */

import { BaseFormatProcessor } from './base-processor';
import { wrapLooseNodes, unwrap } from '../utils/dom-utils';
import { unwrapLayoutTables } from '../utils/transform-helpers';
import { isReferenceHeading } from '../utils/reference-headings';
import { collectReferenceRun, hasEarlyYear, isReferenceShaped } from '../utils/reference-detection';
import {
  applyAnchorFootnotes,
  parseMarkerNumber,
  resolveAnchorFootnotes,
  type ResolvedFootnote,
} from '../utils/anchor-footnotes';

export class GeneralProcessor extends BaseFormatProcessor {
  [key: string]: any;
  constructor() {
    super('general');
  }

  /**
   * Normalize, then dissolve LAYOUT tables (1990s-style page wrappers) so the
   * document flow inside them is visible to footnote/reference extraction and
   * splits into real nodes instead of one unsplittable table blob. Data tables
   * are untouched — see isLayoutTable() in utils/transform-helpers.
   *
   * @param {HTMLElement} dom - DOM element
   */
  normalize(dom: HTMLElement) {
    super.normalize(dom);
    unwrapLayoutTables(dom);
  }

  /**
   * Extract footnotes using heuristic pattern matching
   * Looks for:
   * - <sup> tags with numeric content
   * - Paragraphs starting with "N. " or "N) "
   * - Markdown-style footnotes [^N]
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom: any, bookId: any) {
    const footnotes: any[] = [];
    const footnoteMappings = new Map();

    // The plain-text scanner in footnote-linker turns "…ended in 1979. 12 The
    // next…" into a marker whenever a same-numbered mapping exists. Harmless
    // when there are a handful of notes; with 54 live mappings it manufactures
    // phantom markers all over the body. Only enabled when nothing structural
    // claimed the markers.
    this.skipPlainTextFootnoteScan = false;

    // 0. STRUCTURAL: a real internal-link footnote system, detected by shape
    //    rather than by guessing anchor names. See utils/anchor-footnotes.ts.
    const anchorResult = resolveAnchorFootnotes(dom);
    if (anchorResult.footnotes.length > 0) {
      console.log(`  - 🔗 Anchor footnote system (${anchorResult.tier}, ${anchorResult.shape}): ${anchorResult.footnotes.length} notes`);
      applyAnchorFootnotes(anchorResult.footnotes);
      this.skipPlainTextFootnoteScan = true;

      anchorResult.footnotes.forEach((resolved: ResolvedFootnote) => {
        const identifier = resolved.ordinal;
        const uniqueId = this.generateFootnoteId(bookId, identifier);
        const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);

        footnotes.push(this.createFootnote(
          uniqueId,
          resolved.definitionBlock.innerHTML.trim().replace(/^\s*\[?\d+\]?[.)]?\s*/, ''),
          identifier,
          uniqueRefId,
          `anchor-${anchorResult.tier}`
        ));

        // MOVE the definition out of the body — appendStaticSections re-emits it.
        const parentList = resolved.definitionBlock.parentElement;
        resolved.definitionBlock.remove();
        if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')
            && parentList.children.length === 0) {
          parentList.remove();
        }
      });

      return footnotes;
    }

    // 1. Find all footnote references - both <sup> tags and <a href="#ftnN"> links
    const refIdentifiers = new Set();

    // 1a. Check <sup> tags with numeric content. parseMarkerNumber, not a bare
    // /^\d+$/, so a decorated marker ("[1]", "(1)", "¹") is not thrown away.
    const supElements = dom.querySelectorAll('sup');
    supElements.forEach((sup: any) => {
      const identifier = parseMarkerNumber(sup.textContent) || sup.getAttribute('fn-count-id');
      if (identifier && /^\d+$/.test(identifier)) {
        refIdentifiers.add(identifier);
      }
    });

    // 1b. Check anchor links with #ftn patterns (e.g., <a href="#ftn1">[1]</a> or <a href="...#ftn1">)
    const anchorLinks = dom.querySelectorAll('a[href]');
    anchorLinks.forEach((link: any) => {
      const href = link.getAttribute('href');
      const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
      if (fragmentMatch) {
        refIdentifiers.add(fragmentMatch[1]);
      }
    });

    console.log(`  - Found ${refIdentifiers.size} footnote references (from <sup> and anchor links)`);

    // 2. Find potential footnote definitions (paragraphs starting with "N. ")
    const potentialParagraphDefs = new Map();

    dom.querySelectorAll('p').forEach((p: any) => {
      const pText = p.textContent.trim();
      const match = pText.match(/^(\d+)[\.)\s:]/); // Match "1.", "1)", "1 ", or "1:"

      if (match && pText.length > match[0].length) {
        potentialParagraphDefs.set(match[1], p);
      }
    });

    console.log(`  - Found ${potentialParagraphDefs.size} potential paragraph definitions`);

    // 2b. Fallback: Find definitions in <li> elements (common web pattern)
    // Many sites put footnotes in <ul><li> where each <li> starts with <a>number</a>
    if (refIdentifiers.size > 0) {
      const liDefsFound: any[] = [];
      dom.querySelectorAll('li').forEach((li: any) => {
        // Strategy A: <li> starts with <a> containing a number (e.g. <a href="...">7</a>)
        const firstAnchor = li.querySelector('a');
        if (firstAnchor) {
          const anchorText = parseMarkerNumber(firstAnchor.textContent);
          if (anchorText && refIdentifiers.has(anchorText) && !potentialParagraphDefs.has(anchorText)) {
            potentialParagraphDefs.set(anchorText, li);
            liDefsFound.push(anchorText);
            return;
          }
        }
        // Strategy B: <li> text starts with number pattern (same as <p> check)
        const liText = li.textContent.trim();
        const match = liText.match(/^(\d+)[\.)\s:]/);
        if (match && liText.length > match[0].length && refIdentifiers.has(match[1]) && !potentialParagraphDefs.has(match[1])) {
          potentialParagraphDefs.set(match[1], li);
          liDefsFound.push(match[1]);
        }
      });
      if (liDefsFound.length > 0) {
        console.log(`  - Found ${liDefsFound.length} additional definitions in <li> elements`);
      }
    }

    // 2c. Fallback: Find definitions with anchor-based IDs (<a name="fn1">, <a name="ftn1">, <a name="_ftn1">, etc.)
    // Common in academic PDFs and web exports
    if (refIdentifiers.size > 0) {
      const anchorDefsFound: any[] = [];
      dom.querySelectorAll('a[name^="fn"], a[name^="ftn"], a[name^="_ftn"], a[name^="note"], a[name^="_edn"]').forEach((anchor: any) => {
        const name = anchor.getAttribute('name');
        const numMatch = name.match(/(\d+)/);
        if (numMatch && refIdentifiers.has(numMatch[1]) && !potentialParagraphDefs.has(numMatch[1])) {
          const container = anchor.closest('p, li, div');
          if (container) {
            potentialParagraphDefs.set(numMatch[1], container);
            anchorDefsFound.push(numMatch[1]);
          }
        }
      });
      if (anchorDefsFound.length > 0) {
        console.log(`  - Found ${anchorDefsFound.length} additional definitions via anchor names`);
      }
    }

    // 2d. Fallback: plain-text bracket endnotes (Word / Google-Docs style pastes).
    // Shape: body paragraphs carry mid-text "[N]" markers and the note definitions
    // are paragraphs starting "[N] content" — no <sup>, no anchors. Only attempted
    // when no markup-based refs exist, and never when the document has a
    // references/bibliography heading (there, "[N]" markers are numeric CITATIONS
    // into a reference list, which extractReferences owns).
    if (refIdentifiers.size === 0 && !this.hasReferenceSectionHeading(dom)) {
      const bracketDefs = new Map<string, Element>();
      dom.querySelectorAll('p, li').forEach((el: Element) => {
        const elText = (el.textContent || '').trim();
        const defNumber = elText.match(/^\[(\d+)\]\s+\S/)?.[1];
        if (defNumber && !bracketDefs.has(defNumber)) {
          bracketDefs.set(defNumber, el);
        }
      });

      const markerIds = new Set<string>();
      dom.querySelectorAll('p, li').forEach((el: Element) => {
        const elText = el.textContent || '';
        const markerPattern = /\[(\d+)\]/g;
        let m;
        while ((m = markerPattern.exec(elText)) !== null) {
          if (m.index === 0) continue; // a definition's own prefix, not a marker
          const markerNumber = m[1];
          if (markerNumber) markerIds.add(markerNumber);
        }
      });

      // Definitions must form a contiguous 1..N list and every in-text marker
      // must resolve into it — otherwise this isn't an endnote list and we
      // leave everything alone (no link where ambiguous).
      const defNumbers = [...bracketDefs.keys()].map(Number).sort((a, b) => a - b);
      const isContiguous = defNumbers.length > 0
        && defNumbers[0] === 1
        && defNumbers[defNumbers.length - 1] === defNumbers.length;
      const allMarkersResolve = markerIds.size > 0
        && [...markerIds].every((id) => bracketDefs.has(id));

      if (isContiguous && allMarkersResolve) {
        bracketDefs.forEach((el, id) => {
          refIdentifiers.add(id);
          potentialParagraphDefs.set(id, el);
        });
      }
    }

    // 3. Sanity check: Do all references have definitions?
    let allRefsHaveDefs = refIdentifiers.size > 0;
    for (const refId of refIdentifiers) {
      if (!potentialParagraphDefs.has(refId)) {
        allRefsHaveDefs = false;
        console.log(`  - ⚠️ Reference ${refId} has no matching definition`);
        break;
      }
    }

    // 4. If sanity check passes, extract footnotes
    if (allRefsHaveDefs && refIdentifiers.size > 0) {
      console.log(`  - ✅ All references have definitions, extracting footnotes`);

      for (const identifier of refIdentifiers) {
        const pElement = potentialParagraphDefs.get(identifier);
        if (!pElement) continue;

        // Extract content, removing the number prefix
        // Handles both plain "7." and <a href="...">7</a> patterns
        let content = pElement.innerHTML.trim()
          .replace(/^\s*<a[^>]*>\s*\d+\s*<\/a>\s*/, '')
          .replace(/^\s*\d+[\.)]\s*/, '');

        // Bracket-endnote defs ("[7] content") may carry the prefix inside a
        // wrapper (<span>[7] …</span>), invisible to the string-level regexes
        // above — strip it at the text-node level instead.
        if (/^\s*\[\d+\]/.test(pElement.textContent)) {
          content = this.stripLeadingBracketNumber(pElement);
        }

        const uniqueId = this.generateFootnoteId(bookId, identifier);
        const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);

        footnotes.push(this.createFootnote(
          uniqueId,
          content,
          identifier,
          uniqueRefId,
          'html-paragraph-heuristic'
        ));

        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });

        // Remove the element so it doesn't appear in main content
        const parentList = pElement.parentElement;
        pElement.remove();
        // If this was a <li>, clean up empty parent list
        if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL') && parentList.children.length === 0) {
          parentList.remove();
        }
      }
    } else {
      console.log(`  - ℹ️ Heuristic extraction skipped (not all refs have defs or no refs found)`);
    }

    // 5. Fallback: Handle markdown-style footnotes [^1]: content
    const allParagraphs = dom.querySelectorAll('p');
    allParagraphs.forEach((p: any) => {
      const text = p.textContent.trim();
      const markdownFootnoteMatch = text.match(/^\[\^?(\d+)\]\s*:\s*(.+)$/s);

      if (markdownFootnoteMatch) {
        const identifier = markdownFootnoteMatch[1];
        const content = markdownFootnoteMatch[2].trim();

        if (!footnoteMappings.has(identifier)) {
          const uniqueId = this.generateFootnoteId(bookId, identifier);
          const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);

          // Process the content HTML (may contain links), remove the [^1]: part
          const processedContent = p.innerHTML.replace(/^\[\^?\d+\]\s*:\s*/, '');

          footnotes.push(this.createFootnote(
            uniqueId,
            processedContent,
            identifier,
            uniqueRefId,
            'markdown-html'
          ));

          footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
          p.remove();
        }
      }
    });

    return footnotes;
  }

  /**
   * Does the document contain a references/bibliography section heading?
   * Used to decide ownership of "[N]" markers: with such a heading they are
   * numeric citations into a reference list, not endnote markers.
   */
  hasReferenceSectionHeading(dom: Element) {
    return this.findReferenceSectionHeading(dom) !== null;
  }

  /**
   * Find the document's references/bibliography heading, ANYWHERE in the tree.
   *
   * Clipboard payloads are essentially always wrapped in a container <div>, and
   * extraction runs at Stage 3 — BEFORE transformStructure() unwraps those
   * wrappers — so the old `dom.children` walk found nothing on any real web
   * paste. That made the heading branch dead code and pushed every paste onto
   * the heading-less path, which is how book_1788040795553 got a References
   * section built out of its own body prose.
   */
  findReferenceSectionHeading(dom: Element): Element | null {
    const headings = Array.from(dom.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    return headings.find((el: Element) => isReferenceHeading(el.textContent)) || null;
  }

  /**
   * Remove a leading "[N]" identifier from a definition element's first
   * non-empty text node and return the resulting innerHTML — works even when
   * the prefix is nested inside inline wrappers like <span>/<b>.
   */
  stripLeadingBracketNumber(element: Element) {
    const clone = element.cloneNode(true) as Element;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      if (!text.trim()) continue;
      node.textContent = text.replace(/^\s*\[\d+\]\s*/, '');
      break;
    }
    return clone.innerHTML.trim();
  }

  /**
   * Extract references.
   *
   * STRATEGY 1 — anchor-based (`<a name="ref…">`): structural, trusted outright.
   * STRATEGY 2 — shape + cohort, via utils/reference-detection.ts.
   *
   * Strategy 2 used to be "find a References heading among dom.children, and
   * failing that scan EVERY paragraph bottom-up keeping anything that starts
   * with a capital and contains four digits". Both halves were broken: the
   * heading walk could never see through the clipboard's wrapper <div>, and the
   * fallback predicate accepts ordinary news prose ("…faced something similar in
   * 1773 when Parliament…"). It also copied rather than moved, so every false
   * positive appeared twice — once in the body, once under a fabricated
   * "References" heading. That is the book_1788040795553 report.
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom: any, bookId: any) {
    const references: any[] = [];

    // STRATEGY 1: Anchor-based detection (most reliable)
    const anchorRefs = Array.from<Element>(dom.querySelectorAll('a[name^="ref"]'));
    if (anchorRefs.length > 0) {
      anchorRefs.forEach((anchor: Element) => {
        // Never lift the paste wrapper: an ambiguous container (the root, or one
        // holding several ref anchors) is not a single reference entry.
        const container = anchor.closest('p, li') || anchor.parentElement;
        if (!container || container === dom) return;
        if (container.querySelectorAll('a[name^="ref"]').length !== 1) return;

        references.push({
          // innerHTML, NOT outerHTML — appendStaticSections hosts this inside a
          // fresh <p> and a block cannot nest there.
          content: container.innerHTML,
          originalText: (container.textContent || '').trim(),
          type: 'anchor-based',
          needsKeyGeneration: true,
          originalAnchorId: anchor.getAttribute('name'),
        });

        // MOVE, don't copy — appendStaticSections re-emits it.
        const parent = container.parentElement;
        container.remove();
        if (parent && (parent.tagName === 'UL' || parent.tagName === 'OL') && parent.children.length === 0) {
          parent.remove();
        }
      });

      if (references.length > 0) {
        console.log(`  - Extracted ${references.length} anchor-based references`);
        return references;
      }
    }

    // STRATEGY 2: shape + cohort detection.
    const referenceHeading = this.findReferenceSectionHeading(dom);
    const candidates = referenceHeading
      ? this.collectSectionBlocks(dom, referenceHeading)
      : this.collectCandidateBlocks(dom);

    const accepted = collectReferenceRun(candidates, { headingAnchored: Boolean(referenceHeading) });

    if (accepted.length === 0) {
      console.log(
        referenceHeading
          ? '  - References heading found but no entries matched'
          : '  - No reference section detected'
      );
      return references;
    }

    // The fragment ids the body's own citation links point at. Collected BEFORE the accepted
    // blocks are removed from the DOM, and used to recover each entry's publisher id — see
    // buildReferencesFromBlock.
    const citedFragments = this.collectCitedFragments(dom);

    accepted.forEach((el: Element) => {
      references.push(...this.buildReferencesFromBlock(el, citedFragments));
      // MOVE into the static section. Leaving the source in place is what
      // produced the duplicated body paragraphs.
      el.remove();
    });

    // appendStaticSections emits its own <h2>References</h2>; leaving the source
    // heading behind would show two.
    if (referenceHeading && references.length > 0) referenceHeading.remove();

    console.log(`  - Extracted ${references.length} references`);

    return references;
  }

  /**
   * Every block that could be a bibliography entry, in document order, with
   * nested duplicates dropped (a <p> inside an <li> is not a second candidate).
   */
  collectCandidateBlocks(dom: Element): Element[] {
    const blocks = Array.from<Element>(dom.querySelectorAll('p, li'));
    const seen = new Set(blocks);
    return blocks.filter((el: Element) => {
      let parent = el.parentElement;
      while (parent && parent !== dom) {
        if (seen.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }

  /**
   * The blocks belonging to a reference section, walked in document order from
   * its heading to the next same-or-higher-level heading.
   *
   * Two wrinkles ported from bibliography.py:75-118. A LOWER-level heading is an
   * alphabetical marker inside the bibliography ("A", "B", …) and is skipped. A
   * same-or-higher-level heading normally ends the section, unless the blocks
   * right after it are themselves reference-like with their year near the start
   * — then it is an OCR/markup artifact and collection continues.
   */
  collectSectionBlocks(dom: Element, heading: Element): Element[] {
    const ordered = Array.from<Element>(dom.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li'));
    const start = ordered.indexOf(heading);
    if (start === -1) return [];

    const headingLevel = parseInt(heading.tagName.slice(1), 10);
    const candidates = new Set(this.collectCandidateBlocks(dom));
    const collected: Element[] = [];

    for (let i = start + 1; i < ordered.length; i++) {
      const el = ordered[i];
      if (!el) continue;

      if (/^H[1-6]$/.test(el.tagName)) {
        if (parseInt(el.tagName.slice(1), 10) > headingLevel) continue;
        if (this.looksLikeArtifactHeading(ordered, i)) continue;
        break;
      }

      if (candidates.has(el)) collected.push(el);
    }

    return collected;
  }

  /** True when the blocks following `ordered[index]` read as more references. */
  looksLikeArtifactHeading(ordered: Element[], index: number): boolean {
    let total = 0;
    let refLike = 0;
    for (let i = index + 1; i < ordered.length && total < 3; i++) {
      const el = ordered[i];
      if (!el || /^H[1-6]$/.test(el.tagName)) continue;
      total += 1;
      const text = (el.textContent || '').trim();
      if (isReferenceShaped(text) && hasEarlyYear(text)) refLike += 1;
    }
    return total >= 2 && refLike >= 2;
  }

  /**
   * Turn one accepted block into reference objects, splitting <br>-separated
   * entries (incl. attribute-bearing tags, e.g. DeepL's `<br data-dl-uid="1">`).
   * Only splits when EVERY part reads as an entry, so a stray <br> inside a
   * single reference cannot shred it.
   */
  /**
   * Does this link's visible text read as a citation marker?
   *
   * Necessary because "a link that points into the reference list" is NOT the same as "a citation",
   * and the difference produced a real false positive: the ACM Xanadu page links the words
   * "permissions statement" to `#permissions-statement`, an anchor that happens to sit inside a
   * block the cohort detector accepted as reference-like. Claiming that id turned an ordinary
   * cross-reference into a citation pointing at a bibliography entry.
   *
   * A citation marker is an author-year (contains a 4-digit year) or a numeric/bracketed marker
   * (`[1]`, `12`) — the same two shapes the citation linkers themselves recognise. Prose link text
   * matches neither.
   */
  looksLikeCitationMarker(text: string): boolean {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length > 200) return false;

    return /\b(?:1[5-9]\d{2}|20\d{2})\b/.test(trimmed) || /^\[?\s*\d{1,3}\s*\]?$/.test(trimmed);
  }

  /**
   * Every fragment id this document's own CITATIONS point at, e.g. `#bib24` and
   * `https://elifesciences.org/articles/60080#bib24` both contribute `bib24`.
   *
   * This is the evidence that lets buildReferencesFromBlock recover a reference entry's PUBLISHER
   * id without guessing at naming conventions: an id is only claimed when a citation in the body
   * actually targets it. Two constraints, and both were needed in practice — the fragment regex
   * deliberately matches the one in `paste/utils/citation-linker.ts` (the two must agree on what
   * counts as a fragment, or an id captured here would be looked up under a different spelling
   * there), and the link text must read as a citation marker rather than prose.
   */
  collectCitedFragments(dom: Element): Set<string> {
    const cited = new Set<string>();
    Array.from<Element>(dom.querySelectorAll('a[href]')).forEach((a: Element) => {
      const match = (a.getAttribute('href') || '').match(/#([a-zA-Z][\w-]*)$/);
      if (match && this.looksLikeCitationMarker(a.textContent || '')) cited.add(match[1]);
    });

    return cited;
  }

  /**
   * The id a reference entry is CITED BY, or null.
   *
   * A publisher's reference list carries its own identity, and in-text citations link to it — but
   * that id is frequently not on the block we accepted as the entry. eLife nests it one level in:
   * `<li class="reference-list__item"><div class="reference" id="bib24">`, so reading the `<li>`'s
   * own id finds nothing and all 32 of barnett-2020's citations were dropped as unmappable.
   *
   * Only ids that a body citation actually points at are eligible, which is what makes this safe:
   * a reference entry also contains Google Scholar, DOI and PubMed links that may carry ids of
   * their own, and none of those are ever cited. An entry offering two cited ids is AMBIGUOUS and
   * returns null rather than guessing — one wrong mapping silently attributes a claim to the wrong
   * work, which is worse than leaving the citation unlinked and visibly unresolved.
   */
  citedIdForBlock(el: Element, citedFragments: Set<string>): string | null {
    if (citedFragments.size === 0) return null;

    const found: string[] = [];
    const consider = (id: string | null) => {
      if (id && citedFragments.has(id) && !found.includes(id)) found.push(id);
    };

    consider(el.getAttribute('id'));
    Array.from<Element>(el.querySelectorAll('[id], a[name]')).forEach((child: Element) => {
      consider(child.getAttribute('id'));
      consider(child.getAttribute('name'));
    });

    return found.length === 1 ? found[0] : null;
  }

  buildReferencesFromBlock(el: Element, citedFragments: Set<string> = new Set<string>()): any[] {
    const html = el.innerHTML;

    if (/<br\b[^>]*>/i.test(html)) {
      const parts = html.split(/<br\b[^>]*>/i).map((s: string) => s.trim()).filter((s: string) => s);
      if (parts.length > 1) {
        const texts = parts.map((part: string) => {
          const temp = document.createElement('div');
          temp.innerHTML = part;
          return (temp.textContent || '').trim();
        });

        if (texts.every((text: string) => isReferenceShaped(text))) {
          // No originalAnchorId here on purpose: one block carrying an id has become SEVERAL
          // entries, and there is no way to tell which of them the id belongs to. Attaching it to
          // each would map one publisher id onto every part, and the last write would win — a
          // citation pointed confidently at the wrong reference. These fall back to generated
          // author-year keys like any unlinked entry.
          return parts.map((part: string, i: number) => ({
            content: part,
            originalText: texts[i],
            type: 'html-br-split',
            needsKeyGeneration: true,
          }));
        }
      }
    }

    const entry: {
      content: string;
      originalText: string;
      type: string;
      needsKeyGeneration: boolean;
      originalAnchorId?: string;
    } = {
      content: html,
      originalText: (el.textContent || '').trim(),
      type: 'html-paragraph',
      needsKeyGeneration: true,
    };

    // The publisher's own id for this entry, when a body citation names it. base-processor maps
    // originalAnchorId -> our generated referenceId, which is what lets processInTextCitations
    // convert `<a href="…#bib24">` into a real in-text citation.
    const citedId = this.citedIdForBlock(el, citedFragments);
    if (citedId) entry.originalAnchorId = citedId;

    return [entry];
  }

  /**
   * Transform structure: wrap loose nodes and unwrap unnecessary containers
   * This is the "Structure Preserving" strategy from parseGeneralContent()
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom: any, bookId: any) {
    console.log(`  - Applying general structure transformation`);

    // Find and process all container elements (div, article, section, etc.)
    const containers = Array.from<any>(
      dom.querySelectorAll('div, article, section, main, header, footer, aside, nav, button')
    );

    // Process in reverse order (children before parents)
    containers.reverse().forEach((container: any) => {
      // Wrap any loose text/inline nodes in this container
      wrapLooseNodes(container);

      // Unwrap the container itself (move children to parent)
      unwrap(container);
    });

    // Also unwrap <font> tags
    dom.querySelectorAll('font').forEach(unwrap);

    console.log(`  - Unwrapped ${containers.length} containers`);

    // Finally, wrap any loose inline elements left at the top level of dom
    wrapLooseNodes(dom);
    console.log(`  - Wrapped loose inline elements at top level`);
  }
}
