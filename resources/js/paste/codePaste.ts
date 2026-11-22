/**
 * Code in the paste pipeline — keeping pasted code EXACTLY what was copied.
 *
 * A code block's content is its text: whitespace, tabs, blank lines, `<` and
 * `&` as literal characters. The prose-oriented paste stages (format
 * processors, normalisers, markdown) are built to reshape text, so code is
 * canonicalised into `<pre><code class="language-x">TEXT</code></pre>` BEFORE
 * those stages see it and again after (idempotent), and a paste INTO an
 * existing code block bypasses them entirely (plain text, inserted as a text
 * node).
 *
 * Security: everything here builds DOM from TEXT (`textContent`, text nodes).
 * Clipboard HTML is only ever parsed in an inert DOMParser document (no script
 * execution, no resource loads) to READ text and classes out of it; nothing
 * read from it is written back as markup except a validated `language-x` class.
 */
import { LANGUAGE_CLASS_RE, resolveLanguage } from '../codeBlocks/language';

/** Clipboard MIME type VS Code writes alongside text/html: `{"mode":"python",…}`. */
export const VSCODE_MIME = 'vscode-editor-data';

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'TR', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE', 'UL', 'OL']);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** CRLF / CR → LF. The one deliberate normalisation applied to pasted code. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Build the canonical code-block HTML from TEXT (escaped) + an optional validated language. */
export function codeBlockHtml(text: string, languageId: string | null): string {
  const cls = languageId ? toLanguageClass(languageId) : null;
  const attr = cls ? ` class="${cls}"` : '';
  return `<pre><code${attr}>${escapeHtml(text)}</code></pre>`;
}

/** Map any name to a stored class: known alias → its canonical id; otherwise validated as-is. */
export function toLanguageClass(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/^(language|lang)-/, '');
  if (!name) return null;
  const known = resolveLanguage(name);
  const cls = `language-${known ? known.id : name}`;
  return LANGUAGE_CLASS_RE.test(cls) ? cls : null;
}

/** The language VS Code declares in its clipboard metadata, if any. */
export function vscodeLanguage(meta: string | null | undefined): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { mode?: unknown };
    return typeof parsed.mode === 'string' ? parsed.mode : null;
  } catch {
    return null;
  }
}

/**
 * Text of a code container, honouring the line structures editors put on the
 * clipboard: `<br>` is a newline, and each block child (VS Code's per-line
 * `<div>`, GitHub's line rows) is its own line. Pure text otherwise.
 */
export function codeTextOf(el: Element): string {
  const parts: string[] = [];
  const endsWithNewline = (): boolean => {
    const last = parts.length ? parts[parts.length - 1]! : '';
    return parts.length === 0 || last.endsWith('\n');
  };
  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push((child as Text).data);
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const tag = (child as Element).tagName;
      if (tag === 'BR') { parts.push('\n'); return; }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
      // GitHub/GitLab line-number gutters are not code.
      const cls = (child as Element).getAttribute('class') || '';
      if (/(^|\s)(blob-num|line-numbers?|linenos?|gutter|lineno)(\s|$)/i.test(cls)
        || (child as Element).hasAttribute('data-line-number')) return;
      if (BLOCK_TAGS.has(tag)) {
        if (!endsWithNewline()) parts.push('\n');
        walk(child);
        if (!endsWithNewline()) parts.push('\n');
        return;
      }
      walk(child);
    });
  };
  walk(el);
  let text = normaliseNewlines(parts.join(''));
  // Non-breaking spaces from HTML editors are indentation, not &nbsp; content.
  text = text.replace(/ /g, ' ');
  // Policy: a block's text carries no single trailing newline (marked and line
  // structures add one; the editor's own blocks never have one).
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

/** Find a declared language on a code element or its ancestors (pre, GitHub's highlight div). */
function languageFrom(el: Element, stopAt: Element): string | null {
  let cur: Element | null = el;
  while (cur) {
    for (const cls of Array.from(cur.classList)) {
      const m = /^(?:language|lang)-(.+)$/i.exec(cls)
        || /^highlight-(?:source|text)-([a-z0-9+#-]+)$/i.exec(cls)
        || /^brush:?([a-z0-9+#-]+)$/i.exec(cls);
      if (m && m[1]) {
        const cls2 = toLanguageClass(m[1]);
        if (cls2) return cls2.replace(/^language-/, '');
      }
    }
    const dataLang = cur.getAttribute('data-lang') || cur.getAttribute('data-language');
    if (dataLang && toLanguageClass(dataLang)) return toLanguageClass(dataLang)!.replace(/^language-/, '');
    if (cur === stopAt) break;
    cur = cur.parentElement;
  }
  return null;
}

/** Is `el` a monospace, whitespace-preserving container (VS Code / JetBrains / Xcode rich copy)? */
function isPreformattedContainer(el: Element): boolean {
  const style = (el.getAttribute('style') || '').toLowerCase();
  return /white-space\s*:\s*pre/.test(style) && /monospace|menlo|consolas|courier|mono/.test(style);
}

/**
 * Canonicalise every code block in an HTML string. `<pre>` (with any inner
 * markup — spans, per-line divs, `<br>`s, gutters) becomes
 * `<pre><code class="language-x">TEXT</code></pre>`; invalid language classes
 * are dropped. Returns the input unchanged when it holds no `<pre>`.
 */
export function normalizePastedCodeBlocks(html: string): string {
  if (!html || !/<pre[\s>]/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const pres = Array.from(doc.body.querySelectorAll('pre'));
  if (pres.length === 0) return html;
  for (const pre of pres) {
    // An inner <pre> inside another is handled by its outer one.
    if (pre.parentElement?.closest('pre')) continue;
    const code = pre.querySelector('code');
    const lang = languageFrom(code ?? pre, doc.body);
    const text = codeTextOf(pre);
    const fresh = doc.createElement('pre');
    const freshCode = doc.createElement('code');
    const cls = lang ? toLanguageClass(lang) : null;
    if (cls) freshCode.className = cls;
    freshCode.textContent = text;
    fresh.appendChild(freshCode);
    // Keep the pre's id ONLY if it is a node id (decimal); never foreign ids.
    if (pre.id && /^\d+(\.\d+)*$/.test(pre.id)) fresh.id = pre.id;
    const nodeId = pre.getAttribute('data-node-id');
    if (nodeId && /^[\w-]+$/.test(nodeId)) fresh.setAttribute('data-node-id', nodeId);
    pre.replaceWith(fresh);
  }
  return doc.body.innerHTML;
}

/**
 * Decide whether a whole clipboard is ONE code snippet from an editor, and if
 * so return its canonical code-block HTML (from the clipboard's plain text,
 * which is the exact characters copied). Covers VS Code (its MIME metadata)
 * and editors that copy a single `white-space: pre` monospace container.
 */
export function editorClipboardAsCode(
  plainText: string,
  rawHtml: string,
  vscodeMeta: string | null | undefined,
): string | null {
  if (!plainText) return null;
  const text = normaliseNewlines(plainText).replace(/\n$/, '');
  // A ONE-LINE copy (a word, an expression) pasted into prose is inline text.
  // Chrome copies a fragment of one of OUR code blocks as a single monospace
  // white-space:pre span, which otherwise reads exactly like an editor's
  // clipboard and minted a second code block for a pasted word.
  if (!text.includes('\n')) return null;
  if (vscodeMeta) {
    return codeBlockHtml(text, vscodeLanguage(vscodeMeta));
  }
  if (!rawHtml) return null;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${rawHtml}</body>`, 'text/html');
  const roots = Array.from(doc.body.children).filter((el) => el.tagName !== 'META' && el.tagName !== 'STYLE');
  if (roots.length !== 1) return null;
  const root = roots[0]!;
  if (root.tagName === 'PRE') return null; // normalizePastedCodeBlocks handles real <pre>
  if (!isPreformattedContainer(root)) return null;
  return codeBlockHtml(text, null);
}

/**
 * Pasted HTML SOURCE code (the clipboard's text is markup, but its HTML side is
 * escaped or tagless) → a code block of that source. Extracted unchanged from
 * paste/index.ts. Returns null when it doesn't apply.
 */
export function rawHtmlSourceAsCode(plainText: string, rawHtml: string): string | null {
  // The regex requires a tag name followed by whitespace, > or /, which rules
  // out URLs in angle brackets and DOIs like 18:7<509::AID-SMJ882>3.0.CO;2-Z.
  const plainTextHasHTMLTags = /<\/?[a-z]+[\s>/]/i.test(plainText);
  const looksLikeRawHTMLCode = plainTextHasHTMLTags && (
    (rawHtml.includes('&lt;') || rawHtml.includes('&gt;')) ||
    (Boolean(rawHtml) && !/<[a-z]+[^>]*>/i.test(rawHtml))
  );
  if (!looksLikeRawHTMLCode) return null;
  // Rendered code blocks (GitHub, docs sites) ALSO carry escaped `&lt;` — but
  // they come with a real <pre>, which normalizePastedCodeBlocks turns into a
  // code block that keeps the page's declared language. Don't pre-empt it.
  if (/<pre[\s>]/i.test(rawHtml)) return null;
  return codeBlockHtml(normaliseNewlines(plainText).replace(/\n$/, ''), null);
}

// ---------------------------------------------------------------------------
// Plain-text code with no fence (copied from a terminal, a chat window, a
// plain editor). Without this the markdown path read Python/shell comments
// ("# Read the whole file") as HEADINGS, ate the "#", and split the program
// into paragraphs.
// ---------------------------------------------------------------------------

const CODE_KEYWORD_RE = /^(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|raise|yield|async|await|lambda|const|let|var|function|export|public|private|protected|static|package|func|fn|use|impl|struct|enum|interface|type|module|require|include|#include|#!|echo|cd|sudo|npm|pip|git|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/;
const COMMENT_LINE_RE = /^\s*(#|\/\/|--|\/\*|\*|<!--|%)/;

/** Does one line read as code rather than prose? */
function isCodeLine(line: string): boolean {
  const t = line.trim();
  if (CODE_KEYWORD_RE.test(t)) return true;
  if (/^[ \t]{2,}\S/.test(line)) return true; // indented continuation
  if (/[;{}]$|[:(\[,]$/.test(t) && !/[.!?]["')]?$/.test(t)) return true;
  if (/^[A-Za-z_$][\w.$\[\]'"]*\s*(=|\+=|-=|\*=|:=|=>)\s*\S/.test(t)) return true; // assignment
  if (/^[A-Za-z_$][\w.$]*\(.*\)\s*;?$/.test(t)) return true; // bare call: print(text)
  if (/^[<{\[]/.test(t) && /[>}\]],?$/.test(t)) return true; // markup / JSON line
  return false;
}

/**
 * Plain text that is a PROGRAM → one code block of the exact text, else null.
 * Conservative on purpose (prose pasted as code is worse than code as prose):
 * at least 2 code-shaped lines, and code-shaped lines are ≥ 2/3 of the lines
 * that aren't comments. Comment lines are neutral — "# Title" is exactly the
 * line that is ambiguous between markdown and Python. Only for clipboards whose
 * HTML side carries no structure (headings, lists, tables, links) and with no
 * markdown fence (marked handles those, with their language).
 */
export function plainTextAsCode(plainText: string, rawHtml: string): string | null {
  if (!plainText) return null;
  const text = normaliseNewlines(plainText).replace(/\n+$/, '');
  if (!text.includes('\n') || /^\s*(```|~~~)/m.test(text)) return null;
  if (rawHtml && /<(h[1-6]|ul|ol|li|table|a|img|blockquote)\b/i.test(rawHtml)) return null;

  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const counted = lines.filter((l) => !COMMENT_LINE_RE.test(l));
  if (counted.length < 2) return null;
  const code = counted.filter(isCodeLine).length;
  if (code < 2 || code / counted.length < 2 / 3) return null;
  return codeBlockHtml(text, null);
}
