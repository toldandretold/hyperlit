/**
 * Code-block decoration — syntax colouring + the header bar (language label,
 * copy, expand). RENDER-TIME ONLY: everything added here is removed again by
 * codeBlocks/stripDecoration.ts on the save path.
 *
 * Invariants:
 *  - The node's TEXT never changes. Token spans only split existing text nodes,
 *    and the header carries no text nodes at all (its label is CSS generated
 *    content from a data attribute, its buttons are icon-only with aria-labels).
 *    So hyperlight/hypercite character offsets, the integrity verifier's text
 *    comparison and the read-mode heal gate all see exactly the stored text.
 *  - Existing inline structure (hyperlight <mark>, hypercite <u>) is preserved:
 *    colouring walks the text nodes wherever they sit and wraps PIECES of them,
 *    it never rebuilds the element from a string.
 *  - We never assign highlighter output to innerHTML. hljs's (escaped) output is
 *    parsed in an inert DOMParser document purely to read token boundaries, and
 *    the boundaries are only accepted if their text matches the source exactly.
 *  - In edit mode a block shows its header (with a language picker) but no
 *    token spans: spans inside a contenteditable fight the caret and would
 *    churn the editor's mutation observer.
 */
import type { HLJSApi, HighlightResult, AutoHighlightResult } from 'highlight.js';
import { getLoadedHighlighter, loadHighlighter } from './hljsLoader';
import { CODE_TOKEN_ATTR, RENDER_ONLY_ATTR } from './stripDecoration';
import { declaredLanguage, displayNameFor, resolveLanguage, sanitizeLanguageClasses } from './language';
import { log } from '../utilities/logger';

const FILE = '/codeBlocks/highlight.ts';

/** Grammars auto-detection may choose between (plaintext/markdown/shell-session are too eager). */
const AUTO_SUBSET = [
  'python', 'javascript', 'typescript', 'r', 'bash', 'sql', 'json', 'yaml', 'xml', 'css',
  'php', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'latex', 'diff',
];
/** hljs relevance at/above which an auto-detected language is shown as the label. */
export const MIN_LABEL_RELEVANCE = 7;
/** …and the block must have at least this many non-blank lines (one-liners are guesses). */
export const MIN_LABEL_LINES = 3;
/** Below this relevance we don't even colour — a wrong grammar paints prose garishly. */
const MIN_COLOUR_RELEVANCE = 3;
/** Don't tokenise enormous blocks on the main thread. */
const MAX_HIGHLIGHT_CHARS = 60_000;

export const HEADER_ROLE = 'code-header';
const DECORATED_ATTR = 'data-code-decorated';
const LABEL_ATTR = 'data-code-label';
const DETECTED_ATTR = 'data-code-detected';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface DecorateOptions {
  /** Force edit/read presentation (default: window.isEditing). */
  editing?: boolean;
  /** Apply token colours (default true; offscreen measurement renders skip it). */
  colour?: boolean;
}

interface Run { start: number; end: number; cls: string }

function isEditingNow(): boolean {
  return Boolean((window as unknown as { isEditing?: boolean }).isEditing);
}

/** The element whose text is the code: `pre > code` when present, else the `pre`. */
export function codeTarget(pre: Element): Element {
  return pre.querySelector(':scope > code') ?? pre;
}

function headerOf(pre: Element): HTMLElement | null {
  return pre.querySelector<HTMLElement>(`:scope > [${RENDER_ONLY_ATTR}="${HEADER_ROLE}"]`);
}

/** Text nodes of the code, in order, excluding anything render-only. */
function codeTextNodes(code: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement && n.parentElement.closest(`[${RENDER_ONLY_ATTR}]`))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** The code's text exactly as stored (render-only furniture excluded). */
export function codeText(pre: Element): string {
  return codeTextNodes(codeTarget(pre)).map((t) => t.data).join('');
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function svgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  code: ['M8.5 7 3.5 12l5 5', 'M15.5 7l5 5-5 5'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  expand: ['M14 4h6v6', 'M20 4l-6.5 6.5', 'M10 20H4v-6', 'M4 20l6.5-6.5'],
  chevron: ['M7 10l5 5 5-5'],
  wrap: ['M4 6h16', 'M4 12h13a3 3 0 0 1 0 6h-4', 'M15 15.5 12.5 18l2.5 2.5', 'M4 18h5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
};

export type CodeIconName = keyof typeof ICONS;

/** One of the code-block icons as a fresh SVG (decorative; the button carries the label). */
export function codeIcon(name: CodeIconName): SVGSVGElement {
  return svgIcon(ICONS[name]);
}

function actionButton(action: string, label: string, icon: string[]): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `code-block-btn code-block-btn--${action}`;
  btn.setAttribute('data-code-action', action);
  btn.setAttribute('aria-label', label);
  btn.title = label;
  // Keyboard model (docs/a11y-findings.md): Tab never enters reading content.
  btn.tabIndex = -1;
  btn.appendChild(svgIcon(icon));
  return btn;
}

function buildHeader(editing: boolean, label: string): HTMLElement {
  const header = document.createElement('span');
  header.className = 'code-block-header';
  header.setAttribute(RENDER_ONLY_ATTR, HEADER_ROLE);
  header.setAttribute('contenteditable', 'false');
  header.setAttribute('translate', 'no');

  const left = document.createElement('span');
  left.className = 'code-block-label';
  left.appendChild(svgIcon(ICONS.code));
  if (editing) {
    // The label IS the picker in edit mode (text still via CSS, so the node's
    // textContent never gains the language name).
    const picker = actionButton('language', 'Set code language', ICONS.chevron);
    picker.classList.add('code-block-lang');
    picker.setAttribute('data-label', label);
    picker.setAttribute('aria-haspopup', 'menu');
    left.appendChild(picker);
  } else {
    const name = document.createElement('span');
    name.className = 'code-block-lang';
    name.setAttribute('data-label', label);
    left.appendChild(name);
  }

  const right = document.createElement('span');
  right.className = 'code-block-actions';
  right.appendChild(actionButton('copy', 'Copy code', ICONS.copy));
  right.appendChild(actionButton('expand', 'Expand code', ICONS.expand));

  header.appendChild(left);
  header.appendChild(right);
  return header;
}

/** Icon swap used by the copy button's "Copied" feedback. */
export function setCopyIcon(btn: Element, copied: boolean): void {
  const old = btn.querySelector('svg');
  const next = svgIcon(copied ? ICONS.check : ICONS.copy);
  if (old) old.replaceWith(next); else btn.appendChild(next);
}

function setLabel(pre: Element, label: string): void {
  pre.setAttribute(LABEL_ATTR, label);
  headerOf(pre)?.querySelector('.code-block-lang')?.setAttribute('data-label', label);
}

/** Initial label before colouring: the declared language, else a neutral "Code". */
function initialLabel(pre: Element): string {
  const declared = declaredLanguage(codeTarget(pre));
  if (declared) return declared.lang ? declared.lang.label : displayNameFor(declared.name);
  return pre.getAttribute(LABEL_ATTR) || 'Code';
}

function ensureHeader(pre: Element, editing: boolean): void {
  const existing = headerOf(pre);
  const wantEditing = editing ? '1' : '0';
  if (existing && existing.getAttribute('data-editing') === wantEditing) return;
  const header = buildHeader(editing, initialLabel(pre));
  header.setAttribute('data-editing', wantEditing);
  if (existing) existing.replaceWith(header);
  else pre.insertBefore(header, pre.firstChild);
}

// ---------------------------------------------------------------------------
// Token colouring
// ---------------------------------------------------------------------------

const SAFE_CLASS_TOKEN = /^[a-z][a-z0-9_-]{0,40}$/i;

/**
 * Read token boundaries from hljs's escaped HTML. Parsed in an INERT document
 * (DOMParser never runs scripts or loads resources) and accepted only when the
 * concatenated text equals the source byte for byte; otherwise null.
 */
export function runsFromHighlightHtml(value: string, expected: string): Run[] | null {
  const doc = new DOMParser().parseFromString(`<!doctype html><body><code>${value}</code></body>`, 'text/html');
  const host = doc.body.querySelector('code');
  if (!host) return null;
  const runs: Run[] = [];
  let pos = 0;
  const walk = (node: Node, stack: string[]): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child as Text).data;
        if (!t) return;
        runs.push({ start: pos, end: pos + t.length, cls: stack.join(' ') });
        pos += t.length;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.tagName !== 'SPAN') return walk(el, stack);
        const own = Array.from(el.classList).filter((c) => SAFE_CLASS_TOKEN.test(c));
        walk(el, own.length ? [...stack, ...own] : stack);
      }
    });
  };
  walk(host, []);
  // Any element hljs might emit other than spans still contributes its text, so
  // the host's full text equal to the source means every run lines up with it.
  if (pos !== expected.length || (host.textContent ?? '') !== expected) return null;
  // Merge adjacent runs with identical classes.
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.cls === r.cls && last.end === r.start) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged;
}

/** Split the code's text nodes along `runs`, wrapping classed pieces in token spans. */
function applyRuns(code: Element, runs: Run[]): void {
  const nodes = codeTextNodes(code);
  let offset = 0;
  let ri = 0;
  for (const node of nodes) {
    const nStart = offset;
    const nEnd = offset + node.data.length;
    offset = nEnd;
    if (nStart === nEnd) continue;
    while (ri < runs.length && runs[ri]!.end <= nStart) ri++;
    // Collect the pieces of this text node.
    const pieces: Array<{ text: string; cls: string }> = [];
    let k = ri;
    let any = false;
    while (k < runs.length && runs[k]!.start < nEnd) {
      const r = runs[k]!;
      const a = Math.max(r.start, nStart);
      const b = Math.min(r.end, nEnd);
      if (b > a) {
        pieces.push({ text: node.data.slice(a - nStart, b - nStart), cls: r.cls });
        if (r.cls) any = true;
      }
      if (r.end > nEnd) break;
      k++;
    }
    if (!any) continue;
    const frag = document.createDocumentFragment();
    for (const p of pieces) {
      if (!p.cls) { frag.appendChild(document.createTextNode(p.text)); continue; }
      const span = document.createElement('span');
      span.setAttribute(CODE_TOKEN_ATTR, '');
      span.className = p.cls;
      span.textContent = p.text;
      frag.appendChild(span);
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

function nonBlankLines(text: string): number {
  return text.split('\n').filter((l) => l.trim().length > 0).length;
}

/** Colour one block (idempotent). Exported for tests and the expand sheet. */
export function colourCodeBlock(pre: Element, hljs: HLJSApi): void {
  if (pre.getAttribute(DECORATED_ATTR) === 'coloured') return;
  const code = codeTarget(pre);
  sanitizeLanguageClasses(code);
  if (code !== pre) sanitizeLanguageClasses(pre);
  const text = codeText(pre);
  pre.setAttribute(DECORATED_ATTR, 'coloured');
  if (!text.trim() || text.length > MAX_HIGHLIGHT_CHARS) return;

  const declared = declaredLanguage(code);
  let result: HighlightResult | AutoHighlightResult | null = null;
  try {
    if (declared?.lang && hljs.getLanguage(declared.lang.id)) {
      if (declared.lang.id === 'plaintext') { setLabel(pre, declared.lang.label); return; }
      result = hljs.highlight(text, { language: declared.lang.id, ignoreIllegals: true });
      setLabel(pre, declared.lang.label);
    } else if (declared) {
      // Valid but unknown name ("language-haskell"): label honestly, don't guess colours.
      setLabel(pre, displayNameFor(declared.name));
      return;
    } else {
      const auto = hljs.highlightAuto(text, AUTO_SUBSET);
      if (!auto.language || auto.relevance < MIN_COLOUR_RELEVANCE) { setLabel(pre, 'Code'); return; }
      result = auto;
      pre.setAttribute(DETECTED_ATTR, auto.language);
      const confident = auto.relevance >= MIN_LABEL_RELEVANCE && nonBlankLines(text) >= MIN_LABEL_LINES;
      setLabel(pre, confident ? (resolveLanguage(auto.language)?.label ?? 'Code') : 'Code');
    }
  } catch (err) {
    log.error('Code highlight failed', FILE, err);
    return;
  }
  const runs = result ? runsFromHighlightHtml(result.value, text) : null;
  if (runs) applyRuns(code, runs);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

const pending = new Set<Element>();
let flushScheduled = false;

function scheduleColour(pre: Element): void {
  pending.add(pre);
  if (flushScheduled) return;
  flushScheduled = true;
  loadHighlighter()
    .then((hljs) => {
      flushScheduled = false;
      const batch = Array.from(pending);
      pending.clear();
      for (const p of batch) {
        // Edit mode may have started while the highlighter loaded.
        if (isEditingNow() && p.isConnected) continue;
        colourCodeBlock(p, hljs);
      }
    })
    .catch((err) => {
      flushScheduled = false;
      pending.clear();
      log.error('Code highlighter failed to load', FILE, err);
    });
}

function presIn(root: ParentNode): Element[] {
  const out: Element[] = [];
  if (root instanceof Element && root.tagName === 'PRE') out.push(root);
  root.querySelectorAll('pre').forEach((p) => out.push(p));
  return out.filter((p) => !p.closest(`[${RENDER_ONLY_ATTR}]`));
}

/**
 * Decorate every <pre> under `root` (inclusive): header synchronously (it has
 * height, so offscreen measurement renders need it), colours when the
 * highlighter is ready (synchronously if already loaded — no flash on scroll).
 */
export function decorateCodeBlocks(root: ParentNode, opts: DecorateOptions = {}): void {
  const pres = presIn(root);
  if (pres.length === 0) return;
  const editing = opts.editing ?? isEditingNow();
  const colour = opts.colour ?? true;
  for (const pre of pres) {
    ensureHeader(pre, editing);
    pre.classList.add('code-decorated');
    if (editing || !colour) continue;
    const hljs = getLoadedHighlighter();
    if (hljs) colourCodeBlock(pre, hljs);
    else scheduleColour(pre);
  }
}

/** Remove token spans from one block (keeps marks), optionally the header too. */
export function uncolourCodeBlock(pre: Element): void {
  const code = codeTarget(pre);
  const spans = code.querySelectorAll(`span[${CODE_TOKEN_ATTR}]`);
  if (spans.length) {
    spans.forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    });
    code.normalize();
  }
  pre.removeAttribute(DECORATED_ATTR);
  pre.removeAttribute(DETECTED_ATTR);
}

/** Edit-mode entry: plain text in every block, header switches to its picker form. */
export function enterEditModeCodeBlocks(root: ParentNode): void {
  for (const pre of presIn(root)) {
    uncolourCodeBlock(pre);
    ensureHeader(pre, true);
    pre.classList.add('code-decorated');
  }
  watchNewCodeBlocks(root);
  for (const pre of presIn(root)) {
    if (!pre.hasAttribute(LABEL_ATTR) || pre.getAttribute(LABEL_ATTR) === 'Code') scheduleEditLabel(pre);
  }
}

// A code block CREATED while editing (toolbar convert/merge, paste, undo
// restoring one) must get its edit-mode header at once — otherwise the copy
// button and language picker only appeared after a reload. Header only: edit
// mode never colours. The divEditor observer sees the header insert too; the
// save path strips it (stripCodeDecoration), so the stored content is unchanged.
let editObserver: MutationObserver | null = null;

function watchNewCodeBlocks(root: ParentNode): void {
  editObserver?.disconnect();
  if (!(root instanceof Node)) return;
  editObserver = new MutationObserver((records) => {
    const found = new Set<Element>();
    const edited = new Set<Element>();
    for (const rec of records) {
      // Typing inside a block: re-detect its language label (debounced).
      const target = rec.target instanceof Element ? rec.target : rec.target.parentElement;
      const inPre = target?.closest('pre');
      if (inPre && !target!.closest(`[${RENDER_ONLY_ATTR}]`)) edited.add(inPre);
      rec.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.closest(`[${RENDER_ONLY_ATTR}]`)) return; // our own header
        const own = n.closest('pre');
        if (own) found.add(own);
        n.querySelectorAll('pre').forEach((p) => found.add(p));
      });
    }
    for (const pre of found) {
      if (!pre.isConnected || pre.closest(`[${RENDER_ONLY_ATTR}]`)) continue;
      const header = headerOf(pre);
      if (header && header.getAttribute('data-editing') === '1') continue;
      ensureHeader(pre, true);
      pre.classList.add('code-decorated');
    }
    for (const pre of new Set([...found, ...edited])) scheduleEditLabel(pre);
  });
  editObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

// ---------------------------------------------------------------------------
// Edit-mode language label: detection WITHOUT colouring (edit mode keeps the
// code as plain text for the caret), so a pasted or typed block names its
// language while you're still editing instead of saying "Code" until exit.
// ---------------------------------------------------------------------------

const EDIT_LABEL_DEBOUNCE_MS = 600;
const labelTimers = new Map<Element, ReturnType<typeof setTimeout>>();

function scheduleEditLabel(pre: Element): void {
  const prev = labelTimers.get(pre);
  if (prev) clearTimeout(prev);
  labelTimers.set(pre, setTimeout(() => {
    labelTimers.delete(pre);
    if (!pre.isConnected) return;
    loadHighlighter()
      .then((hljs) => { if (pre.isConnected) labelCodeBlock(pre, hljs); })
      .catch((err) => log.error('Code highlighter failed to load', FILE, err));
  }, EDIT_LABEL_DEBOUNCE_MS));
}

/** Set `pre`'s label from its declared language, else confident auto-detection. Never touches the text. */
export function labelCodeBlock(pre: Element, hljs: HLJSApi): void {
  const declared = declaredLanguage(codeTarget(pre));
  if (declared) {
    setLabel(pre, declared.lang ? declared.lang.label : displayNameFor(declared.name));
    return;
  }
  const text = codeText(pre);
  if (!text.trim() || text.length > MAX_HIGHLIGHT_CHARS) { setLabel(pre, 'Code'); return; }
  try {
    const auto = hljs.highlightAuto(text, AUTO_SUBSET);
    const confident = !!auto.language && auto.relevance >= MIN_LABEL_RELEVANCE && nonBlankLines(text) >= MIN_LABEL_LINES;
    setLabel(pre, confident ? (resolveLanguage(auto.language!)?.label ?? 'Code') : 'Code');
  } catch (err) {
    log.error('Code label detection failed', FILE, err);
  }
}

/** Edit-mode exit: read-mode header + colours again (text may have changed). */
export function exitEditModeCodeBlocks(root: ParentNode): void {
  editObserver?.disconnect();
  editObserver = null;
  for (const t of labelTimers.values()) clearTimeout(t);
  labelTimers.clear();
  for (const pre of presIn(root)) {
    uncolourCodeBlock(pre);
  }
  decorateCodeBlocks(root, { editing: false });
}

// ---------------------------------------------------------------------------
// Caret preservation (for un-colouring a block the user starts typing into)
// ---------------------------------------------------------------------------

function offsetWithin(container: Element, node: Node, nodeOffset: number): number | null {
  if (!container.contains(node)) return null;
  const nodes = codeTextNodes(container);
  let total = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    for (const t of nodes) {
      if (t === node) return total + nodeOffset;
      total += t.data.length;
    }
    return null;
  }
  // Element boundary: count text before the child at nodeOffset.
  const ref = node.childNodes[nodeOffset] ?? null;
  for (const t of nodes) {
    if (ref && (ref === t || ref.contains(t) || (ref.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING))) break;
    if (!ref && !node.contains(t) && (node.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    total += t.data.length;
  }
  return total;
}

function pointAt(container: Element, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  const nodes = codeTextNodes(container);
  for (const t of nodes) {
    if (remaining <= t.data.length) return { node: t, offset: remaining };
    remaining -= t.data.length;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.data.length } : { node: container, offset: container.childNodes.length };
}

/** Un-colour `pre` while keeping the user's selection at the same text offsets. */
export function uncolourPreservingSelection(pre: Element): void {
  const sel = window.getSelection();
  const code = codeTarget(pre);
  let saved: { a: number; f: number } | null = null;
  if (sel && sel.rangeCount && sel.anchorNode && sel.focusNode) {
    const a = offsetWithin(code, sel.anchorNode, sel.anchorOffset);
    const f = offsetWithin(code, sel.focusNode, sel.focusOffset);
    if (a !== null && f !== null) saved = { a, f };
  }
  uncolourCodeBlock(pre);
  if (saved && sel) {
    const pa = pointAt(code, saved.a);
    const pf = pointAt(code, saved.f);
    sel.setBaseAndExtent(pa.node, pa.offset, pf.node, pf.offset);
  }
}
