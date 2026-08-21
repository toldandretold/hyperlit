/**
 * The two reader iframes (citing | cited). Jumping is a full reload per
 * candidate — the reader resolves a URL hash to a node only at LOAD time
 * (scrolling/internalNav.ts) and has no hashchange handler, so assigning a
 * src that differs only in the hash would neither reload nor scroll. Hence:
 * blank the frame, then set the target on the next frame. A postMessage
 * scroll bridge in utilities/embeddedReader.ts is the noted follow-up.
 *
 * Both panes frame OUR OWN reader (same origin, real books) — not fetched
 * publisher pages — so the fetched-source sandbox rule doesn't apply here,
 * and the console can reach into contentDocument to MARK the evidence: the
 * quote beside the citation on the citing side, the located span on the
 * cited side. Marks reuse the reader's own `mark.search-highlight` styling
 * (resources/css/components/searchHighlight.css ships in the reader page) but
 * are applied with the IFRAME document's createRange/createElement — a Range
 * minted by the parent document throws WrongDocumentError on iframe nodes,
 * which is why search/inTextSearch/searchHighlight.ts can't be called across
 * the boundary directly.
 */

import { verbose } from '../utilities/logger';

export interface MarkSpec {
  nodeId: string;                                  // data-node-id of the target node
  range?: { start: number; end: number };          // textContent offsets (charData space)
  search?: { text: string; near: number };         // find text, occurrence nearest `near`
  wholeNode?: boolean;                             // mark the entire node (blockquotes)
}

const MARK_POLL_MS = 400;
const MARK_POLL_TRIES = 30; // ≈12s — covers chunk lazy-load after the hash nav

export class ReaderPane {
  private frame: HTMLIFrameElement;
  private placeholder: HTMLElement | null;
  private label: HTMLElement | null;
  private current = '';

  constructor(frameId: string, placeholderId: string, labelId: string) {
    this.frame = document.getElementById(frameId) as HTMLIFrameElement;
    this.placeholder = document.getElementById(placeholderId);
    this.label = document.getElementById(labelId);
  }

  /**
   * Load `/book#target`, forcing a reload even when only the hash changed,
   * then (optionally) mark the evidence spans once their nodes render.
   *
   * `force` reloads even when the URL is IDENTICAL — needed right after an
   * approve/revert, when the citing book's content changed under an unchanged
   * URL (the freshly spliced ↗ doesn't render otherwise).
   *
   * NAVIGATION DISCIPLINE (hard-won): a different BOOK gets one direct src
   * assignment — the blank-hop-then-set dance under rapid clicks lost the
   * second assignment in WebKit and left panes on about:blank (Safari-blank
   * on prod, reproduced by the list-walk e2e under the webkit config). Only
   * a same-document target needs the blank hop (the reader resolves hashes
   * at LOAD time only), chained on the blank's `load` event rather than a
   * rAF. A watchdog reasserts the URL if the frame is still blank after 2s —
   * whatever the churn dropped, the pane converges on the selection.
   */
  show(book: string, target: string | null, labelText: string, marks: MarkSpec[] = [], force = false): void {
    const url = `/${book}${target ? `#${target}` : ''}`;
    if (this.label) this.label.textContent = labelText;
    if (this.placeholder) this.placeholder.hidden = true;
    if (!force && url === this.current) {
      if (marks.length) this.applyMarksWhenReady(url, marks);
      return;
    }
    const prevPath = this.current.split('#')[0];
    this.current = url;

    if (prevPath !== `/${book}`) {
      // Fresh document — one navigation, nothing deferred to lose.
      this.frame.src = url;
    } else {
      // Same document, new target (or forced reload): hop through about:blank
      // so the reader re-runs its load-time hash navigation.
      const onBlankLoad = () => {
        this.frame.removeEventListener('load', onBlankLoad);
        if (this.current === url) this.frame.src = url;
      };
      this.frame.addEventListener('load', onBlankLoad);
      this.frame.src = 'about:blank';
      window.setTimeout(() => {
        // The blank's load event can be missed if the frame was already
        // blank — converge regardless.
        this.frame.removeEventListener('load', onBlankLoad);
        if (this.current === url && this.frameHref() === 'about:blank') {
          this.frame.src = url;
        }
      }, 200);
    }

    window.setTimeout(() => {
      if (this.current === url && this.frameHref() === 'about:blank') {
        verbose.nav(`hypercites: pane stuck blank — reasserting ${url}`, 'maintainerHypercites');
        this.frame.src = url;
      }
    }, 2000);

    // Second-stage watchdog: the frame NAVIGATED but the reader died booting —
    // rapid selection churn aborts its module imports/fetches mid-flight and
    // the last document can come up empty (seen under WebKit: "Importing a
    // module script failed" + fresh-page-load pathway failure). One reload
    // from a settled frame recovers it.
    window.setTimeout(() => {
      if (this.current !== url) return;
      const doc = this.frame.contentDocument;
      const rendered = doc?.querySelector('[data-node-id], .chunk');
      if (doc && this.frameHref() !== 'about:blank' && !rendered) {
        verbose.nav(`hypercites: reader never rendered — reloading ${url}`, 'maintainerHypercites');
        this.frame.src = 'about:blank';
        window.setTimeout(() => {
          if (this.current === url) this.frame.src = url;
        }, 100);
      }
    }, 8000);

    if (marks.length) this.applyMarksWhenReady(url, marks);
  }

  private frameHref(): string {
    try {
      return this.frame.contentWindow?.location.href ?? '';
    } catch {
      return ''; // never cross-origin here, but stay defensive
    }
  }

  clear(placeholderText: string): void {
    this.current = '';
    this.frame.src = 'about:blank';
    if (this.placeholder) {
      this.placeholder.hidden = false;
      this.placeholder.textContent = placeholderText;
    }
  }

  /**
   * Poll the framed reader until the FIRST spec's node exists (the hash nav
   * loads its chunk; neighbours ride along), then mark everything present.
   * Aborts silently if the selection moved on.
   */
  private applyMarksWhenReady(url: string, marks: MarkSpec[], tries = 0): void {
    const first = marks[0];
    if (!first || this.current !== url || tries > MARK_POLL_TRIES) return;

    const doc = this.frame.contentDocument;
    const anchor = doc?.querySelector(`[data-node-id="${CSS.escape(first.nodeId)}"]`);
    if (!doc || !anchor) {
      window.setTimeout(() => this.applyMarksWhenReady(url, marks, tries + 1), MARK_POLL_MS);
      return;
    }

    // The node exists but the reader keeps re-rendering it for a while
    // (annotation hydration, then a background content re-sync when the
    // book's clock moved) — and every re-render WIPES injected marks. So
    // marks are applied and then RE-applied whenever they disappear, for a
    // grace window after load. Cheap check (one selector), self-limiting.
    const applyAll = () => {
      const liveDoc = this.frame.contentDocument;
      if (!liveDoc) return;
      for (const spec of marks) {
        try {
          this.applyOne(liveDoc, spec);
        } catch (err) {
          verbose.nav(`hypercites: mark failed for ${spec.nodeId}: ${String(err)}`, 'maintainerHypercites');
        }
      }
    };

    window.setTimeout(() => {
      if (this.current !== url) return;
      applyAll();
      let checks = 0;
      const keepAlive = () => {
        if (this.current !== url || checks++ > 25) return; // ~20s grace
        const liveDoc = this.frame.contentDocument;
        if (liveDoc && !liveDoc.querySelector('[data-hx-mark]')) applyAll();
        window.setTimeout(keepAlive, 800);
      };
      window.setTimeout(keepAlive, 800);
    }, 600);
  }

  private applyOne(doc: Document, spec: MarkSpec): void {
    const el = doc.querySelector(`[data-node-id="${CSS.escape(spec.nodeId)}"]`);
    if (!el) return;

    const text = el.textContent ?? '';
    let start: number | null = null;
    let end: number | null = null;

    if (spec.wholeNode) {
      start = 0;
      end = text.length;
    } else if (spec.range) {
      start = spec.range.start;
      end = Math.min(spec.range.end, text.length);
    } else if (spec.search) {
      // All occurrences, nearest the marker — same tiebreak the detector used.
      const needle = spec.search.text;
      let best: number | null = null;
      let from = 0;
      for (;;) {
        const idx = text.indexOf(needle, from);
        if (idx === -1) break;
        if (best === null || Math.abs(idx - spec.search.near) < Math.abs(best - spec.search.near)) {
          best = idx;
        }
        from = idx + 1;
      }
      if (best === null) return;
      start = best;
      end = best + needle.length;
    }
    if (start === null || end === null || end <= start) return;

    const pos = findPositions(el, start, end);
    if (!pos) return;

    const mark = doc.createElement('mark');
    mark.className = 'search-highlight current';
    mark.dataset.hxMark = '1';

    const range = doc.createRange();
    range.setStart(pos.startNode, pos.startOffset);
    range.setEnd(pos.endNode, pos.endOffset);
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

interface DomPositions {
  startNode: Node;
  startOffset: number;
  endNode: Node;
  endOffset: number;
}

function textNodesOf(element: Element): Node[] {
  const out: Node[] = [];
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out.push(node);
    else if (node.nodeType === Node.ELEMENT_NODE) out.push(...textNodesOf(node as Element));
  }
  return out;
}

/** textContent offsets → concrete text-node positions (searchHighlight.ts's walk). */
function findPositions(element: Element, startChar: number, endChar: number): DomPositions | null {
  const nodes = textNodesOf(element);
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  let i = 0;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    if (startNode === null && i <= startChar && i + len > startChar) {
      startNode = node;
      startOffset = startChar - i;
    }
    if (i <= endChar && i + len >= endChar) {
      endNode = node;
      endOffset = endChar - i;
      if (startNode) break;
    }
    i += len;
  }

  return startNode && endNode ? { startNode, startOffset, endNode, endOffset } : null;
}
