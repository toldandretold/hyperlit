/**
 * Make a static-section payload safe to live INSIDE a <p>.
 *
 * `appendStaticSections` is the single place that hosts arbitrary processor
 * output in a freshly created <p>, and eleven processors feed it. Several pass
 * a BLOCK element's outerHTML (or a clone whose innerHTML contains top-level
 * blocks). A block cannot legally nest inside a <p>: fragment parsing with a `p`
 * context element does not auto-close, so the DOM really does hold
 *
 *     <p data-static-content="bibliography"><p>Smith, J. (2020)…</p></p>
 *
 * which survives until the next serialize -> reparse (base-processor's
 * linkCitations, then html-block-parser). Reparsed in a <div> context the inner
 * <p> closes the outer one and the stray </p> becomes an orphan, so ONE entry
 * lands in the node store as THREE nodes:
 *
 *     <p data-static-content="bibliography"></p>   empty, keeps the attribute
 *     <p>Smith, J. (2020)…</p>                     the text, attribute LOST
 *     <p></p>
 *
 * That is the phantom-bibliography node pattern from book_1788040795553, and
 * because the surviving text node loses `data-static-content` it also defeats
 * every reader that skips static sections (citation-linker.ts:42,78,
 * CitationParser.php:73, CitationScanContentCommand.php:112).
 *
 * Fixing the producers is necessary but not sufficient — this is the choke point,
 * so the invariant is enforced here too. cambridge-processor.ts:205-208 documents
 * the same trap from the producer side.
 */

import { isBlockElement, unwrap } from './dom-utils';

/**
 * Flatten `html` so it contains no top-level block elements.
 *
 * - A sole block wrapper is unwrapped to its contents (the `outerHTML` case).
 * - Several top-level blocks are unwrapped in place, joined by <br>, so a
 *   multi-paragraph footnote still reads as one paragraph rather than silently
 *   splitting into a tagged empty node plus untagged orphans.
 * - Inline payloads are returned untouched.
 */
export function flattenForInlineHost(html: string | null | undefined, doc: Document = document): string {
  if (!html) return html ?? '';
  // Nothing to flatten without markup.
  if (!/<[a-z]/i.test(html)) return html;

  const temp = doc.createElement('div');
  temp.innerHTML = html;

  // Peel sole block wrappers: "<div><p>x</p></div>" -> "x". Bounded so a
  // pathological nest cannot spin.
  let guard = 0;
  for (;;) {
    const sole = temp.childNodes.length === 1 ? temp.children[0] : undefined;
    if (guard >= 5 || !sole || !isBlockElement(sole.tagName)) break;
    temp.innerHTML = sole.innerHTML;
    guard += 1;
  }

  // Any remaining top-level blocks (or blocks sitting beside loose text) are
  // unwrapped in place with a <br> separator.
  Array.from(temp.children).forEach((child) => {
    if (!isBlockElement(child.tagName)) return;
    if (child.previousSibling && child.parentNode) {
      child.parentNode.insertBefore(doc.createElement('br'), child);
    }
    unwrap(child);
  });

  return temp.innerHTML;
}
