/**
 * speakableText — TS port of app/Services/Tts/SpeakableText.php for LOCAL
 * (BYO-key) audiobook generation in the native shell.
 *
 * The one place that decides what text a node "speaks", derived from `content`
 * (never plainText — see the PHP header for why). Structural inline elements
 * are VERBALIZED, not leaked:
 *   hypercite arrow (`.open-icon`, any historical nesting) → "(hypercite link)"
 *   footnote marker (`sup[fn-count-id]` / `.footnote-ref`) → "(footnote N)"
 *   numeric citation (`[<a class="in-text-citation">9</a>]`) → "(citation 9)"
 *   math (`latex`/`latex-block`, empty in storage)          → "equation"
 *   page-number markers (`.pageNumber`), images             → dropped
 *   decoration (mark/u/em/strong/…)                         → unwrapped
 *
 * PARITY: tests/javascript/aiProviders/speakableTextFixtures.json is consumed
 * by BOTH the vitest suite here and a Pest test running the PHP original —
 * drift between the two implementations fails CI on both sides. The local
 * manifest is a closed world with its own hashes, so byte-parity with the
 * server's source_hash is NOT required — but keeping the derivations aligned
 * keeps narration quality identical.
 */

// Sentinel wrappers for citation anchors (resolved in the text pass).
const CITE_OPEN = '\uE000';
const CITE_CLOSE = '\uE001';

export function speakableTextFromContent(content: string | null | undefined): string {
  const html = content ?? '';
  if (html.trim() === '') return '';

  let text = domPass(html);

  // Citation sentinels → speakable form. ONLY the bracketed numeric marker
  // convention ("[<a>13</a>]") is verbalized as "(citation 13)"; author-year
  // anchors read as written.
  text = text.replace(
    new RegExp(`\\[\\s*${CITE_OPEN}([\\d\\s,;&\\u2013-]+?)${CITE_CLOSE}\\s*\\]`, 'gu'),
    (_m, inner: string) => ` (citation ${inner.replace(/\s+/g, ' ').trim()}) `
  );
  // Remaining sentinels (unbracketed, or bracketed-but-textual): unwrap.
  text = text.replace(new RegExp(`${CITE_OPEN}(.*?)${CITE_CLOSE}`, 'gsu'), '$1');

  // Invisible characters the TTS must never see: word-joiner (the hypercite
  // seam), zero-widths, soft hyphen, BOM.
  text = text.replace(/[\u2060\u200B\u200C\u200D\u00AD\uFEFF]/gu, '');

  // Belt-and-braces: no arrow glyph (or its surviving entity text) reaches TTS.
  text = text.replace(/\u2197|&nearr;/gu, '');

  // Whitespace + punctuation seams left by marker replacement.
  text = text.replace(/\s+/gu, ' ');
  text = text.replace(/\s+([,.;:!?])/gu, '$1');
  text = text.replace(/\(\s+/gu, '(');
  text = text.replace(/\s+\)/gu, ')');

  return text.trim();
}

export function isSpeakable(content: string | null | undefined): boolean {
  return speakableTextFromContent(content) !== '';
}

/** DOM transform → plain text (DOMParser always yields a document). */
function domPass(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<div data-speakable-root="1">${html}</div>`,
    'text/html'
  );
  const root = doc.querySelector('[data-speakable-root]');
  if (!root) return html.replace(/<[^>]*>/g, ''); // parser refused — tag-strip fallback

  // 1. Hypercite arrows — replace the OUTERMOST arrow-bearing element (the <a>
  //    when it wraps the sup).
  for (const el of Array.from(root.querySelectorAll('.open-icon'))) {
    if (!el.isConnected) continue;
    const target =
      el.parentElement && el.parentElement.tagName.toLowerCase() === 'a' ? el.parentElement : el;
    replaceWithText(target, ' (hypercite link) ');
  }

  // 2. Footnote markers — sup[fn-count-id], sup.footnote-ref, or a
  //    .footnote-ref inside a sup (no :has() — unreliable in happy-dom).
  for (const sup of Array.from(root.querySelectorAll('sup'))) {
    if (!sup.isConnected) continue;
    const attr = (sup.getAttribute('fn-count-id') ?? '').trim();
    const isFootnote =
      attr !== '' || sup.classList.contains('footnote-ref') || !!sup.querySelector('.footnote-ref');
    if (!isFootnote) continue;
    const n = attr !== '' ? attr : (sup.textContent ?? '').trim();
    replaceWithText(sup, n === '' ? ' (footnote) ' : ` (footnote ${n}) `);
  }

  // 3. Pipeline citation anchors → sentinel-wrapped inner text (resolved in the
  //    text pass, where the surrounding literal brackets are visible).
  for (const a of Array.from(root.querySelectorAll('a.in-text-citation'))) {
    if (!a.isConnected) continue;
    replaceWithText(a, CITE_OPEN + (a.textContent ?? '') + CITE_CLOSE);
  }

  // 4. Never-spoken subtrees: page-number markers, images.
  for (const el of Array.from(root.querySelectorAll('.pageNumber, img'))) {
    el.remove();
  }

  // 5. Math is stored EMPTY (KaTeX renders from data-math client-side).
  for (const el of Array.from(root.querySelectorAll('latex'))) {
    replaceWithText(el, ' equation ');
  }
  for (const el of Array.from(root.querySelectorAll('latex-block'))) {
    replaceWithText(el, ' Equation. ');
  }

  // 6. Word boundaries: <br> and block-element seams become spaces.
  for (const br of Array.from(root.querySelectorAll('br'))) {
    replaceWithText(br, ' ');
  }
  for (const block of Array.from(
    root.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, div, tr, dt, dd')
  )) {
    block.appendChild(doc.createTextNode(' '));
  }

  return root.textContent ?? '';
}

function replaceWithText(node: Element, text: string): void {
  const parent = node.parentNode;
  if (!parent || !node.ownerDocument) return;
  parent.replaceChild(node.ownerDocument.createTextNode(text), node);
}

// ── Segmenting (port of GenerateBookAudioJob::splitSentences/hardWrap) ────────

/**
 * Split text into segments of at most maxChars, preferring sentence boundaries,
 * then any whitespace, then a hard cut.
 */
export function splitSentences(text: string, maxChars: number): string[] {
  const segments: string[] = [];
  let current = '';

  const sentences = text.split(/(?<=[.!?])\s+|\n+/u).filter((s) => s !== '');
  for (const sentence of sentences.length ? sentences : [text]) {
    // A single sentence longer than the cap: flush, then hard-wrap it.
    if (sentence.length > maxChars) {
      if (current.trim() !== '') {
        segments.push(current.trim());
        current = '';
      }
      segments.push(...hardWrap(sentence, maxChars));
      continue;
    }

    if (current.length + sentence.length + 1 > maxChars && current.trim() !== '') {
      segments.push(current.trim());
      current = '';
    }
    current += (current === '' ? '' : ' ') + sentence;
  }
  if (current.trim() !== '') segments.push(current.trim());

  return segments;
}

function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/u).filter((w) => w !== '');
  let current = '';

  for (const word of words) {
    // A single word longer than the cap gets hard-cut (PHP wordwrap cut=true).
    if (word.length > maxChars) {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxChars) {
        const piece = word.slice(i, i + maxChars);
        if (piece.length === maxChars) out.push(piece);
        else current = piece;
      }
      continue;
    }
    if (current.length + word.length + 1 > maxChars && current !== '') {
      out.push(current);
      current = '';
    }
    current += (current === '' ? '' : ' ') + word;
  }
  if (current !== '') out.push(current);

  return out.map((s) => s.trim()).filter((s) => s !== '');
}
