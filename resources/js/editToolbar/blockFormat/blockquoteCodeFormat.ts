// Blockquote/code commands + content-preserving wrap/unwrap helpers (self = BlockFormatter).

import {
  findClosestBlockParent,
  getBlockElementsInRange,
  getTextOffsetInElement,
  setCursorAtTextOffset,
  selectAcrossElements,
  findClosestListItem,
  isBlockElement,
} from "../toolbarDOMUtils";
import {
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from "../../utilities/idHelpers";
import {
  batchUpdateIndexedDBRecords,
} from "../../indexedDB/index";
import { asLineId } from "../../utilities/idHelpers";
import { BLOCK_ELEMENT_SELECTOR } from "../../utilities/blockElements";
import type { BlockCommandContext } from "./types";

// A blockquote may legally hold block children (a <ul>, a nested <p>); a <p>
// may NOT — `<p><ul>…</ul></p>` survives in the live DOM but collapses to an
// EMPTY node on its next parse (the invalid-nesting data-loss class; integrity
// report book_1788217034868). Unwrapping such a blockquote must land in a
// <div> instead. `li` added: not in the block set but just as illegal in a <p>.
const P_ILLEGAL_CHILD_SELECTOR = `${BLOCK_ELEMENT_SELECTOR}, li`;

// Both helpers MOVE the live child nodes into the new element \u2014 never rebuild
// via innerHTML re-parse. Re-parsing cloned every child (hypercite <u>/<a>,
// highlight <mark>) and destroyed live node identity: listeners died, the
// MutationObserver saw removal churn for every embedded hypercite, and the
// browser's native undo stack (iOS shake-undo) was left pointing at destroyed
// nodes \u2014 the source of the format-toggle duplication bug.
export function _contentPreservingWrap(self: BlockCommandContext, element: Element, type: 'blockquote' | 'code'): HTMLElement {
    let newEl: HTMLElement;
    if (type === "blockquote") {
      newEl = document.createElement("blockquote");
      while (element.firstChild) newEl.appendChild(element.firstChild);
      // Blockquote convention: content ends with a <br> (empty stays empty)
      if (newEl.lastChild && newEl.lastChild.nodeName !== "BR") {
        newEl.appendChild(document.createElement("br"));
      }
    } else {
      newEl = document.createElement("pre");
      const code = document.createElement("code");
      while (element.firstChild) code.appendChild(element.firstChild);
      toCodeText(code);
      newEl.appendChild(code);
    }

    newEl.id = element.id;
    if (element.hasAttribute("data-node-id")) {
      newEl.setAttribute("data-node-id", element.getAttribute("data-node-id")!);
    }

    element.parentNode!.replaceChild(newEl, element);
    return newEl;
  }

export function _contentPreservingUnwrap(self: BlockCommandContext, element: Element, type: 'blockquote' | 'code'): HTMLElement {
    const source: Element = type === "code" ? (element.querySelector("code") ?? element) : element;

    // Block children can't move into a <p> (see P_ILLEGAL_CHILD_SELECTOR above).
    const p = document.createElement(
      source.querySelector(P_ILLEGAL_CHILD_SELECTOR) ? "div" : "p"
    );
    if (type === "blockquote" && source.lastChild && source.lastChild.nodeName === "BR") {
      source.lastChild.remove(); // strip the wrap-convention trailing <br>
    }
    while (source.firstChild) p.appendChild(source.firstChild);
    if (!p.hasChildNodes()) p.textContent = "\u00A0";

    p.id = element.id;
    if (element.hasAttribute("data-node-id")) {
      p.setAttribute("data-node-id", element.getAttribute("data-node-id")!);
    }

    element.parentNode!.replaceChild(p, element);
    return p;
  }

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * PRE → blockquote content TRANSFORM: the code's text lines become
 * <br>-separated blockquote lines (+ the trailing-<br> convention). Never
 * move the <code> element itself — nesting it produced an inline code pill
 * inside the blockquote (the code→blockquote corruption bug).
 */
function preToBlockquote(pre: Element): HTMLElement {
  const source = pre.querySelector("code") ?? pre;
  const lines = (source.textContent ?? "").replace(/\n$/, "").split("\n");
  const bq = document.createElement("blockquote");
  bq.innerHTML = lines.map(escapeHtml).join("<br>") + "<br>";
  bq.id = pre.id;
  if (pre.hasAttribute("data-node-id")) {
    bq.setAttribute("data-node-id", pre.getAttribute("data-node-id")!);
  }
  return bq;
}

/** Blockquote → PRE content TRANSFORM: <br>-separated lines become newline-joined code text. */
function blockquoteToPre(bq: Element): HTMLElement {
  let content = bq.innerHTML;
  if (content.endsWith("<br>")) content = content.slice(0, -4);
  const text = content
    .split(/<br\s*\/?>/i)
    .map((part) => {
      const temp = document.createElement("div");
      temp.innerHTML = part;
      return temp.textContent ?? "";
    })
    .join("\n");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);
  pre.id = bq.id;
  if (bq.hasAttribute("data-node-id")) {
    pre.setAttribute("data-node-id", bq.getAttribute("data-node-id")!);
  }
  return pre;
}

export async function handleBlockquoteCodeFormat(self: BlockCommandContext, type: 'blockquote' | 'code', isTextSelected: boolean, parentElement: Element) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-paragraph wrapping
      const range = self.selectionManager.currentSelection!.getRangeAt(0);

      // A selection INSIDE one code block + code toggle (the P button) →
      // the selected lines become paragraphs; code above/below stays code.
      const startPre = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest("pre");
      const endPre = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest("pre");
      if (type === "code" && startPre && startPre === endPre) {
        return await codeLinesToParagraphs(self, startPre as HTMLElement, range);
      }
      const affectedBlocks = getBlockElementsInRange(range);

      // Only allow paragraph elements for blockquote/code conversion
      const paragraphBlocks = affectedBlocks.filter((block): block is HTMLElement => block.tagName === 'P');

      if (paragraphBlocks.length > 1 && type === "blockquote") {
        // Multiple paragraphs → merge into a single blockquote (items joined by <br>)
        return await self._mergeBlocksIntoBlockquote(paragraphBlocks);
      } else if (paragraphBlocks.length > 1 && type === "code") {
        // Multiple paragraphs → ONE code block. A program pasted as prose
        // arrives split at its blank lines; one <pre> per paragraph would
        // chop it into separate cards with separate headers.
        return await _mergeBlocksIntoCode(self, paragraphBlocks);
      } else if (paragraphBlocks.length > 0) {
        // Single paragraph: convert it to its own block (1:1)
        // This preserves node_ids so highlights stay connected
        const createdBlocks: HTMLElement[] = [];

        for (const block of paragraphBlocks) {
          const newBlockElement = self._contentPreservingWrap(block, type);

          if (self.undoManager) {
            self.undoManager.recordFormat(
              newBlockElement.id,
              (el: HTMLElement) => self._contentPreservingUnwrap(el, type),
              (el: HTMLElement) => self._contentPreservingWrap(el, type),
              self.currentBookId,
              0
            );
          }
          createdBlocks.push(newBlockElement);

          // Save (no delete needed since node_id is preserved)
          if (self.currentBookId && self.saveToIndexedDBCallback) {
            await self.saveToIndexedDBCallback(asLineId(newBlockElement.id), newBlockElement.outerHTML);
          }
        }

        // Select the first new block
        if (createdBlocks.length > 0) {
          self.selectionManager.currentSelection!.selectAllChildren(createdBlocks[0]!);
          modifiedElementId = createdBlocks[0]!.id;
          newElement = createdBlocks[0];
        }
      } else {
        // Fallback for selections not in paragraphs
        console.warn("Selection for block format is not within a recognized block.");
        const containingBlock = findClosestBlockParent(parentElement);
        if (containingBlock) {
          const beforeId = findPreviousElementId(containingBlock);
          const afterId = findNextElementId(containingBlock);

          document.execCommand("formatBlock", false, type);

          const newElem =
            document.getElementById(beforeId)?.nextElementSibling ||
            document.getElementById(afterId)?.previousElementSibling;
          if (newElem && self.saveToIndexedDBCallback) {
            setElementIds(newElem, beforeId, afterId, self.currentBookId);
            modifiedElementId = newElem.id;
            newElement = newElem;
            await self.saveToIndexedDBCallback(asLineId(modifiedElementId), newElement.outerHTML);
          }
        }
      }
    } else {
      // Cursor-only wrapping/unwrapping
      const blockParentToToggle = findClosestBlockParent(parentElement);
      const isBlockquote = blockParentToToggle?.tagName === "BLOCKQUOTE";
      const isCode = blockParentToToggle?.tagName === "PRE";

      // Only allow paragraph wrapping (or unwrapping existing blockquote/code)
      if (blockParentToToggle &&
          blockParentToToggle.tagName !== 'P' &&
          !isBlockquote &&
          !isCode) {
        console.warn(`Cannot convert ${blockParentToToggle.tagName} to ${type} - only paragraphs allowed`);
        return { modifiedElementId, newElement };
      }

      if (type === "code" && isCode) {
        // Code → paragraphs, ONE PER LINE. Unwrapping into a single <p> kept the
        // "\n"s as text, which a paragraph collapses into one run-on line.
        return await codeLinesToParagraphs(self, blockParentToToggle as HTMLElement, null);
      } else if (type === "blockquote" && isBlockquote) {
        // UNWRAPPING
        ({ modifiedElementId, newElement } = await self.unwrapBlock(blockParentToToggle, type));
      } else if ((type === "blockquote" && isCode) || (type === "code" && isBlockquote)) {
        // CROSS-CONVERSION (code ↔ blockquote): transform the CONTENT, never
        // wrap — wrapBlock would move the <code> element INTO the blockquote
        // (or the blockquote's <br>-laden children into <code>), producing the
        // nested inline-code corruption.
        const original = blockParentToToggle!;
        let currentOffset = 0;
        try {
          currentOffset = getTextOffsetInElement(
            original,
            self.selectionManager.currentSelection!.focusNode,
            self.selectionManager.currentSelection!.focusOffset,
          );
        } catch (e) { /* ignore */ }

        const originalHTML = original.outerHTML;
        const converted = type === "blockquote" ? preToBlockquote(original) : blockquoteToPre(original);

        if (self.undoManager) {
          self.undoManager.recordFormat(
            original.id,
            // Undo: restore the original block verbatim
            (el: Element) => {
              const temp = document.createElement("div");
              temp.innerHTML = originalHTML;
              const restored = temp.firstElementChild!;
              el.parentNode!.replaceChild(restored, el);
              return restored;
            },
            // Redo: re-run the content transform
            (el: Element) => {
              const redone = type === "blockquote" ? preToBlockquote(el) : blockquoteToPre(el);
              el.parentNode!.replaceChild(redone, el);
              return redone;
            },
            self.currentBookId,
            currentOffset,
          );
        }

        original.parentNode!.replaceChild(converted, original);
        setCursorAtTextOffset(converted, currentOffset);
        self.selectionManager.currentSelection = window.getSelection();

        modifiedElementId = converted.id;
        newElement = converted;
      } else if (blockParentToToggle) {
        // WRAPPING
        ({ modifiedElementId, newElement } = await self.wrapBlock(blockParentToToggle, type));
      }
    }

    return { modifiedElementId, newElement };
  }

export async function unwrapBlock(self: BlockCommandContext, blockToUnwrap: Element, type: 'blockquote' | 'code') {
    // Capture cursor offset before DOM replacement
    const currentOffset = getTextOffsetInElement(
      blockToUnwrap,
      self.selectionManager.currentSelection!.focusNode,
      self.selectionManager.currentSelection!.focusOffset
    );

    const newElement = self._contentPreservingUnwrap(blockToUnwrap, type);
    const modifiedElementId = newElement.id;

    if (self.undoManager) {
      self.undoManager.recordFormat(
        newElement.id,
        (el: HTMLElement) => self._contentPreservingWrap(el, type),
        (el: HTMLElement) => self._contentPreservingUnwrap(el, type),
        self.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    // source: 'edit' — a blockquote/code conversion rewrites the element.
    await batchUpdateIndexedDBRecords([{ id: asLineId(newElement.id), html: newElement.outerHTML }], { source: 'edit' });

    return { modifiedElementId, newElement };
  }

export async function wrapBlock(self: BlockCommandContext, blockParentToToggle: Element, type: 'blockquote' | 'code') {
    const currentOffset = getTextOffsetInElement(
      blockParentToToggle,
      self.selectionManager.currentSelection!.focusNode,
      self.selectionManager.currentSelection!.focusOffset
    );

    const newElement = self._contentPreservingWrap(blockParentToToggle, type);
    const modifiedElementId = newElement.id;

    if (self.undoManager) {
      self.undoManager.recordFormat(
        newElement.id,
        (el: HTMLElement) => self._contentPreservingUnwrap(el, type),
        (el: HTMLElement) => self._contentPreservingWrap(el, type),
        self.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    // Since we preserve node_id, just save the updated content (no delete needed)
    if (self.saveToIndexedDBCallback && newElement.id) {
      await self.saveToIndexedDBCallback(asLineId(newElement.id), newElement.outerHTML);
    }

    return { modifiedElementId, newElement };
  }

export async function _mergeBlocksIntoBlockquote(self: BlockCommandContext, paragraphs: HTMLElement[]) {
    const bq = document.createElement("blockquote");

    // Inherit identity from first paragraph
    const firstP = paragraphs[0]!;
    bq.id = firstP.id;
    if (firstP.hasAttribute("data-node-id")) {
      bq.setAttribute("data-node-id", firstP.getAttribute("data-node-id")!);
    }

    // Snapshot for undo — BEFORE moving children empties the paragraphs
    const originalParagraphsHTML = paragraphs.map((p: HTMLElement) => p.outerHTML);
    const extraIds = paragraphs.slice(1).map((p: HTMLElement) => p.id);

    // Move live children (same reasoning as _contentPreservingWrap), one <br>
    // between paragraphs plus the trailing convention <br>.
    // NOTE: the undo/redo closures below still rebuild from HTML snapshots by
    // design (explicit toolbar undo) — converting them is a separate refactor.
    paragraphs.forEach((para: HTMLElement, i: number) => {
      if (i > 0) bq.appendChild(document.createElement("br"));
      while (para.firstChild) bq.appendChild(para.firstChild);
    });
    bq.appendChild(document.createElement("br"));

    // Record undo
    if (self.undoManager) {
      self.undoManager.recordFormat(
        firstP.id,
        // Undo: blockquote → paragraphs (restore originals)
        (el: HTMLElement) => {
          const parent = el.parentNode!;
          // Insert all paragraphs before the blockquote, then remove it
          for (const html of originalParagraphsHTML) {
            const temp = document.createElement("div");
            temp.innerHTML = html;
            parent.insertBefore(temp.firstElementChild!, el);
          }
          parent.removeChild(el);
          return document.getElementById(firstP.id);
        },
        // Redo: paragraphs → blockquote
        (el: HTMLElement) => {
          const parent = el.parentNode!;
          const newBq = document.createElement("blockquote");
          const allParas = [el, ...extraIds.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => x !== null)];
          const c = allParas.map((p: HTMLElement) => p.innerHTML).join("<br>");
          newBq.innerHTML = c + "<br>";
          newBq.id = el.id;
          if (el.hasAttribute("data-node-id")) newBq.setAttribute("data-node-id", el.getAttribute("data-node-id")!);
          for (const p of allParas.slice(1)) {
            p.remove();
          }
          parent.replaceChild(newBq, el);
          return newBq;
        },
        self.currentBookId,
        0
      );
    }

    // Insert blockquote where first paragraph was, remove all paragraphs
    firstP.parentNode!.insertBefore(bq, firstP);
    for (const p of paragraphs) {
      p.remove();
    }

    // Save blockquote to IndexedDB
    if (self.saveToIndexedDBCallback) {
      await self.saveToIndexedDBCallback(asLineId(bq.id), bq.outerHTML);
    }

    // Delete extra paragraphs from IndexedDB
    if (self.deleteFromIndexedDBCallback) {
      for (const id of extraIds) {
        await self.deleteFromIndexedDBCallback(asLineId(id));
      }
    }

    self.selectionManager.currentSelection = window.getSelection();
    setCursorAtTextOffset(bq, 0);

    return { modifiedElementId: bq.id, newElement: bq };
  }

/** Replace every <br> under `el` with a newline text node (code holds newlines as TEXT). */
function brToNewlines(el: Element): void {
  for (const br of Array.from(el.querySelectorAll("br"))) {
    br.replaceWith(document.createTextNode("\n"));
  }
}

/**
 * Merge multiple paragraphs into ONE <pre><code>. Live children are MOVED (same
 * reasoning as _contentPreservingWrap: highlight <mark>s and hypercite <u>s keep
 * their identity), <br>s become "\n" text.
 *
 * Separator: if any paragraph is itself multi-line, the paragraphs are the
 * blank-line-separated chunks of a pasted program (smallPasteHandler splits
 * plain text on /\n\s*\n/), so they rejoin with a blank line. If every
 * paragraph is one line, they are typed lines (Enter per line) and rejoin with
 * a single newline — a blank line between each would double-space the code.
 */
export async function _mergeBlocksIntoCode(self: BlockCommandContext, paragraphs: HTMLElement[]) {
  const firstP = paragraphs[0]!;
  const originalParagraphsHTML = paragraphs.map((p) => p.outerHTML);
  const extraIds = paragraphs.slice(1).map((p) => p.id);

  const multiLine = paragraphs.some(
    (p) => p.querySelector("br") !== null || (p.textContent ?? "").replace(/\n+$/, "").includes("\n"),
  );
  const separator = multiLine ? "\n\n" : "\n";

  const build = (paras: HTMLElement[], idSource: HTMLElement): HTMLElement => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    paras.forEach((para, i) => {
      brToNewlines(para);
      // Trailing newlines inside a paragraph would stack onto the separator.
      const last = para.lastChild;
      if (last && last.nodeType === Node.TEXT_NODE) last.textContent = (last.textContent ?? "").replace(/\n+$/, "");
      if (i > 0) code.appendChild(document.createTextNode(separator));
      while (para.firstChild) code.appendChild(para.firstChild);
    });
    toCodeText(code);
    pre.appendChild(code);
    pre.id = idSource.id;
    if (idSource.hasAttribute("data-node-id")) {
      pre.setAttribute("data-node-id", idSource.getAttribute("data-node-id")!);
    }
    return pre;
  };

  const pre = build(paragraphs, firstP);

  if (self.undoManager) {
    self.undoManager.recordFormat(
      firstP.id,
      // Undo: code block → the original paragraphs
      (el: HTMLElement) => {
        const parent = el.parentNode!;
        for (const html of originalParagraphsHTML) {
          const temp = document.createElement("div");
          temp.innerHTML = html;
          parent.insertBefore(temp.firstElementChild!, el);
        }
        parent.removeChild(el);
        return document.getElementById(firstP.id);
      },
      // Redo: paragraphs → one code block
      (el: HTMLElement) => {
        const parent = el.parentNode!;
        const allParas = [el, ...extraIds.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => x !== null)];
        const redone = build(allParas, el);
        for (const p of allParas.slice(1)) p.remove();
        parent.replaceChild(redone, el);
        return redone;
      },
      self.currentBookId,
      0,
    );
  }

  firstP.parentNode!.insertBefore(pre, firstP);
  for (const p of paragraphs) p.remove();

  if (self.saveToIndexedDBCallback) {
    await self.saveToIndexedDBCallback(asLineId(pre.id), pre.outerHTML);
  }
  if (self.deleteFromIndexedDBCallback) {
    for (const id of extraIds) {
      await self.deleteFromIndexedDBCallback(asLineId(id));
    }
  }

  self.selectionManager.currentSelection = window.getSelection();
  setCursorAtTextOffset(pre, 0);

  return { modifiedElementId: pre.id, newElement: pre };
}

/**
 * Make prose-editor text into code text, in place: <br> → "\n", nbsp → space
 * (contenteditable stores typed leading spaces as nbsp, and an nbsp-indented
 * Python line is a syntax error once copied out), zero-width caret anchors
 * dropped. Marks/hypercite wrappers are kept — only their text changes.
 */
function toCodeText(code: Element): void {
  brToNewlines(code);
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    const next = t.data.replace(/\u00A0/g, " ").replace(/\u200B/g, "");
    if (next !== t.data) t.data = next;
  }
  code.normalize();
}

/** The code's TEXT nodes in order, excluding render-only furniture (the header). */
function codeTextNodesOf(code: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.parentElement?.closest("[data-render-only]")) out.push(t);
  }
  return out;
}

/** Character offset of (node, offset) within the code's text nodes. */
function codeOffset(nodes: Text[], node: Node, offset: number): number {
  let total = 0;
  for (const t of nodes) {
    if (t === node) return total + offset;
    if (node.nodeType !== Node.TEXT_NODE && node.contains(t)) {
      // Element boundary: count the text before child[offset].
      const ref = node.childNodes[offset] ?? null;
      if (ref && (ref === t || ref.contains(t) || (ref.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING))) return total;
    }
    total += t.data.length;
  }
  return total;
}

/**
 * Code block → paragraphs. With `range` (a selection inside the block) only the
 * lines it touches convert; lines above stay in this block and lines below go
 * to a new code block with the same language. With no range, every line
 * converts. One paragraph per non-blank line. The first emitted element keeps
 * the block's id + data-node-id; new ones are minted between the REAL
 * neighbours (a node's id is its position).
 *
 * Each piece is CLONED from the original DOM by range, not rebuilt from text,
 * so highlight <mark>s and hypercite <u>/<a> anchors travel with their text
 * (hypercite anchors live in the node HTML — rebuilding from text deleted
 * them). The save recomputes each node's highlight offsets from the marks it
 * now holds, exactly as an Enter split does.
 */
export async function codeLinesToParagraphs(self: BlockCommandContext, pre: HTMLElement, range: Range | null) {
  const code = pre.querySelector(":scope > code") ?? pre;
  const originalHTML = pre.outerHTML;

  // Zero-width caret anchors (legacy Enter handling) are not code text.
  for (const t of codeTextNodesOf(code)) {
    if (t.data.includes("\u200B")) t.data = t.data.replace(/\u200B/g, "");
  }
  const nodes = codeTextNodesOf(code);
  const full = nodes.map((t) => t.data).join("");
  const text = full.replace(/\n+$/, "");

  // Line spans [start, end) in `text`.
  const spans: Array<[number, number]> = [];
  let pos = 0;
  for (const line of text.split("\n")) { spans.push([pos, pos + line.length]); pos += line.length + 1; }
  const lineOf = (off: number) => text.slice(0, off).split("\n").length - 1;

  let first = 0;
  let last = spans.length - 1;
  if (range) {
    const a = codeOffset(nodes, range.startContainer, range.startOffset);
    let b = codeOffset(nodes, range.endContainer, range.endOffset);
    // A selection ending at the very start of a line doesn't include that line.
    if (b > a && full[b - 1] === "\n") b -= 1;
    first = lineOf(Math.min(a, text.length));
    last = Math.max(first, lineOf(Math.min(b, text.length)));
  }
  const blank = (i: number) => text.slice(spans[i]![0], spans[i]![1]).trim() === "";

  /** DOM point for a text offset; starts snap forward, ends snap back, so no empty wrapper clones. */
  const pointAt = (off: number, isStart: boolean): [Node, number] => {
    let acc = 0;
    for (let i = 0; i < nodes.length; i++) {
      const len = nodes[i]!.data.length;
      if (off < acc + len || (off === acc + len && (!isStart || i === nodes.length - 1))) return [nodes[i]!, off - acc];
      acc += len;
    }
    const lastNode = nodes[nodes.length - 1];
    return lastNode ? [lastNode, lastNode.data.length] : [code, code.childNodes.length];
  };
  const slice = (a: number, b: number): DocumentFragment => {
    const r = document.createRange();
    const [sn, so] = pointAt(a, true);
    const [en, eo] = pointAt(b, false);
    r.setStart(sn, so);
    r.setEnd(en, eo);
    const frag = r.cloneContents();
    frag.querySelectorAll("[data-render-only]").forEach((e) => e.remove());
    return frag;
  };

  const langClass = code !== pre ? code.getAttribute("class") : null;
  const makePre = (frag: DocumentFragment): HTMLElement => {
    const el = document.createElement("pre");
    const c = document.createElement("code");
    if (langClass) c.setAttribute("class", langClass);
    c.appendChild(frag);
    el.appendChild(c);
    return el;
  };
  const makeP = (frag: DocumentFragment): HTMLElement => {
    const p = document.createElement("p");
    p.appendChild(frag);
    // Leading indentation would collapse in a paragraph: keep it visible.
    const firstText = codeTextNodesOf(p)[0];
    if (firstText) {
      firstText.data = firstText.data.replace(/^[ \t]+/, (ws) => ws.replace(/ /g, "\u00A0").replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0"));
    }
    return p;
  };

  const out: HTMLElement[] = [];
  // Before: lines above the selection, minus blank lines at the seam.
  let bEnd = first - 1;
  while (bEnd >= 0 && blank(bEnd)) bEnd--;
  if (bEnd >= 0) out.push(makePre(slice(0, spans[bEnd]![1])));
  // Middle: one paragraph per non-blank line.
  for (let i = first; i <= last; i++) {
    if (!blank(i)) out.push(makeP(slice(spans[i]![0], spans[i]![1])));
  }
  if (!out.length) {
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    out.push(p);
  }
  // After: lines below the selection, minus blank lines at the seam.
  let aStart = last + 1;
  while (aStart < spans.length && blank(aStart)) aStart++;
  if (aStart < spans.length) out.push(makePre(slice(spans[aStart]![0], text.length)));

  const nextId = findNextElementId(pre);

  // Identity: the first element inherits the block's; the rest are minted in order.
  out[0]!.id = pre.id;
  if (pre.hasAttribute("data-node-id")) out[0]!.setAttribute("data-node-id", pre.getAttribute("data-node-id")!);
  for (let i = 1; i < out.length; i++) {
    setElementIds(out[i]!, out[i - 1]!.id, nextId, self.currentBookId);
  }

  const parent = pre.parentNode!;
  for (const el of out) parent.insertBefore(el, pre);
  parent.removeChild(pre);

  const postHTML = out.map((el) => el.outerHTML);
  const createdIds = out.slice(1).map((el) => el.id);
  if (self.undoManager) {
    self.undoManager.recordFormat(
      out[0]!.id,
      // Undo: the original block back, created nodes gone
      (el: Element) => {
        for (const id of createdIds) document.getElementById(id)?.remove();
        const temp = document.createElement("div");
        temp.innerHTML = originalHTML;
        const restored = temp.firstElementChild!;
        el.parentNode!.replaceChild(restored, el);
        return restored;
      },
      // Redo: the converted nodes again, same ids
      (el: Element) => {
        const parentEl = el.parentNode!;
        let firstEl: Element | null = null;
        for (const html of postHTML) {
          const temp = document.createElement("div");
          temp.innerHTML = html;
          const node = temp.firstElementChild!;
          parentEl.insertBefore(node, el);
          firstEl ??= node;
        }
        parentEl.removeChild(el);
        return firstEl;
      },
      self.currentBookId,
      0,
    );
  }

  // Caret into the first converted paragraph (or the first node).
  const focusEl = out.find((el) => el.tagName === "P") ?? out[0]!;
  setCursorAtTextOffset(focusEl, 0);
  self.selectionManager.currentSelection = window.getSelection();

  if (self.saveToIndexedDBCallback) {
    for (const el of out) {
      await self.saveToIndexedDBCallback(asLineId(el.id), el.outerHTML);
    }
  }

  return { modifiedElementId: focusEl.id, newElement: focusEl };
}
