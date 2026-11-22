/**
 * @vitest-environment jsdom
 *
 * Pasting hostile content, as code and as rich HTML.
 *
 *   - Inside a code block a payload must survive as VISIBLE TEXT (that is what
 *     a code block is for) and never as a live element or attribute.
 *   - Outside code, nothing executable may reach the paste output: no script-
 *     capable elements, no on* handlers, no javascript:/data:text/html URLs.
 *   - A language class is only ever `language-[a-z0-9+#-]{1,30}`; anything
 *     else is dropped, so a crafted fence info string / class can't inject
 *     attributes or CSS hooks.
 *   - The copy button copies TEXT only.
 *
 * Driven through the same real paste stages as codePasteFidelity.test.js.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../../resources/js/divEditor/index', () => ({ queueNodeForSave: vi.fn() }));

import { marked } from 'marked';
import { sanitizeHtml } from '../../../resources/js/utilities/sanitizeConfig';
import { detectFormat } from '../../../resources/js/paste/format-detection/format-detector';
import { getFormatConfig } from '../../../resources/js/paste/format-detection/format-registry';
import { detectMarkdown } from '../../../resources/js/paste/utils/markdown-detector';
import { preprocessMarkdownFootnotes, footnoteDefinitionsToHtml } from '../../../resources/js/paste/utils/markdown-processor';
import { estimatePasteNodeCount } from '../../../resources/js/paste/utils/dom-helpers';
import { stripMarkTags, stripHyperciteTags, convertDefinitionListTags, normalizeListItems } from '../../../resources/js/paste/utils/normalizer';
import { editorClipboardAsCode, rawHtmlSourceAsCode, normalizePastedCodeBlocks } from '../../../resources/js/paste/codePaste';
import { handleCodeBlockPaste } from '../../../resources/js/paste/handlers/codeBlockHandler';
import { loadHighlighter } from '../../../resources/js/codeBlocks/hljsLoader';
import { decorateCodeBlocks, codeText } from '../../../resources/js/codeBlocks/highlight';
import { stripCodeDecoration } from '../../../resources/js/codeBlocks/stripDecoration';

beforeAll(async () => { await loadHighlighter(); });

async function convertClipboard({ plain = '', html = '', vscode = null }) {
  let plainText = plain;
  let rawHtml = stripHyperciteTags(stripMarkTags(html));
  const editorCode = editorClipboardAsCode(plainText, rawHtml, vscode) ?? rawHtmlSourceAsCode(plainText, rawHtml);
  if (editorCode) { rawHtml = editorCode; plainText = ''; }
  rawHtml = normalizePastedCodeBlocks(rawHtml);
  let htmlContent = '';
  if (rawHtml.trim()) {
    const config = getFormatConfig(detectFormat(rawHtml)) ?? getFormatConfig('general');
    const processor = new config.processor();
    const result = estimatePasteNodeCount(rawHtml) <= 10
      ? await processor.processLite(rawHtml, 'book_sec_test')
      : await processor.process(rawHtml, 'book_sec_test');
    htmlContent = result.html;
  } else if (detectMarkdown(plainText)) {
    const { text, footnoteDefinitions } = preprocessMarkdownFootnotes(plainText);
    htmlContent = normalizeListItems(sanitizeHtml(marked(text) + footnoteDefinitionsToHtml(footnoteDefinitions)));
  }
  return convertDefinitionListTags(normalizePastedCodeBlocks(htmlContent));
}

const DANGEROUS_TAGS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META', 'BASE', 'FORM', 'FRAME', 'FRAMESET', 'NOSCRIPT', 'TEMPLATE']);
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'srcdoc', 'background', 'poster'];

/** Every executable thing in an HTML string, as a list of findings (empty = inert). */
function executableFindings(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = [];
  for (const el of doc.body.querySelectorAll('*')) {
    if (DANGEROUS_TAGS.has(el.tagName)) out.push(`<${el.tagName.toLowerCase()}>`);
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) out.push(`${el.tagName.toLowerCase()}[${a.name}]`);
      if (a.name === 'srcdoc') out.push(`${el.tagName.toLowerCase()}[srcdoc]`);
      if (URL_ATTRS.includes(a.name.toLowerCase())) {
        const v = a.value.replace(/[\u0000- ]+/g, '').toLowerCase();
        if (/^(javascript|vbscript):/.test(v) || /^data:text\/html/.test(v)) out.push(`${el.tagName.toLowerCase()}[${a.name}=${a.value}]`);
      }
      if (a.name === 'style' && /expression\(|javascript:|url\(\s*['"]?\s*javascript/i.test(a.value)) out.push(`style=${a.value}`);
    }
  }
  return out;
}

const PAYLOADS = {
  script: '<script>window.__pwned = 1</script>',
  imgOnerror: '<img src=x onerror="window.__pwned=1">',
  svgOnload: '<svg onload="window.__pwned=1"><circle r="5"/></svg>',
  iframeSrcdoc: '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
  jsHref: '<a href="javascript:window.__pwned=1">click</a>',
  jsHrefObfuscated: '<a href="jav&#x09;ascript:alert(1)">x</a><a href=" javascript:alert(1)">y</a>',
  dataHtml: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  styleExpr: '<style>body{background:url(javascript:alert(1))}</style><p style="width:expression(alert(1))">p</p>',
  noscriptMxss: '<noscript><p title="</noscript><img src=x onerror=window.__pwned=1>">',
  mathMxss: '<math><mtext><table><mglyph><style><img src=x onerror=window.__pwned=1></style></mglyph></table></mtext></math>',
  formAction: '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">go</button></form>',
  breakout: '</code></pre><script>window.__pwned=1</script><pre><code>',
};

describe('the detector itself is not vacuous', () => {
  // Every payload except the pure-text breakout must be FLAGGED in its raw form,
  // or "no findings" below would prove nothing.
  it.each(Object.entries(PAYLOADS).filter(([n]) => n !== 'breakout' && n !== 'noscriptMxss' && n !== 'mathMxss'))('%s is detected raw', (_n, payload) => {
    expect(executableFindings(payload).length).toBeGreaterThan(0);
  });
});

describe('hostile payloads pasted AS CODE stay visible text', () => {
  describe.each(Object.entries(PAYLOADS))('%s', (_name, payload) => {
    it('in a markdown fence: exact text, nothing live', async () => {
      const html = await convertClipboard({ plain: '```html\n' + payload + '\n```' });
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      const code = doc.querySelector('pre > code');
      expect(code).not.toBeNull();
      expect(code.textContent).toBe(payload);
      expect(code.children.length).toBe(0);
      expect(executableFindings(html)).toEqual([]);
    });

    it('in a <pre> on a web page: exact text, nothing live', async () => {
      const esc = payload.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = await convertClipboard({ plain: payload, html: `<pre><code class="language-html">${esc}</code></pre>` });
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      expect(doc.querySelector('pre > code').textContent).toBe(payload);
      expect(executableFindings(html)).toEqual([]);
    });

    it('into an existing code block: inserted as a text node', () => {
      const host = document.createElement('div');
      host.contentEditable = 'true';
      host.innerHTML = '<pre id="900"><code></code></pre>';
      document.body.appendChild(host);
      const code = host.querySelector('code');
      const r = document.createRange();
      r.selectNodeContents(code);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
      handleCodeBlockPaste({
        clipboardData: { getData: (t) => (t === 'text/plain' ? payload : payload) },
        preventDefault() {},
      }, null, null);
      expect(code.textContent).toBe(payload);
      expect(code.children.length).toBe(0);
      host.remove();
    });

    it('decorated for reading: still inert, copy yields the exact text', () => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-html';
      code.textContent = payload;
      pre.appendChild(code);
      const host = document.createElement('div');
      host.appendChild(pre);
      decorateCodeBlocks(host, { editing: false });
      expect(codeText(pre)).toBe(payload);
      for (const el of code.querySelectorAll('*')) expect(el.tagName).toBe('SPAN');
      const clone = pre.cloneNode(true);
      stripCodeDecoration(clone);
      expect(executableFindings(clone.outerHTML)).toEqual([]);
    });
  });
});

describe('hostile payloads pasted AS RICH HTML never reach the output live', () => {
  it.each(Object.entries(PAYLOADS))('%s', async (_name, payload) => {
    const html = await convertClipboard({ plain: 'x', html: `<p>before</p>${payload}<p>after</p>` });
    expect(executableFindings(html)).toEqual([]);
  });
  it('nothing actually executed during any of this', () => {
    expect(window.__pwned).toBeUndefined();
  });
});

describe('language classes are validated, never trusted', () => {
  it('a fence info string cannot inject an attribute', async () => {
    const html = await convertClipboard({ plain: '```" onmouseover="window.__pwned=1\nx = 1\n```' });
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const code = doc.querySelector('pre > code');
    expect(code.textContent).toBe('x = 1');
    expect(code.getAttribute('class')).toBeNull();
    expect(executableFindings(html)).toEqual([]);
    expect(html).not.toMatch(/onmouseover/);
  });

  it.each([
    ['quote', 'language-x" onclick="alert(1)'],
    ['angle', 'language-<svg>'],
    ['overlong', 'language-' + 'a'.repeat(31)],
    ['uppercase css hook', 'language-X_Y'],
    ['braces', 'language-a{}'],
  ])('a crafted %s class on pasted <pre><code> is dropped', async (_n, cls) => {
    const attr = cls.replace(/"/g, '&quot;');
    const html = await convertClipboard({ plain: 'x', html: `<pre><code class="${attr}">print(1)</code></pre>` });
    const code = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('pre > code');
    expect(code.textContent).toBe('print(1)');
    expect(code.getAttribute('class')).toBeNull();
    expect(executableFindings(html)).toEqual([]);
  });

  it('VS Code metadata with a hostile mode is dropped', async () => {
    const html = await convertClipboard({ plain: 'a\nb', html: '<div>a</div><div>b</div>', vscode: JSON.stringify({ mode: '"><script>' }) });
    const code = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('pre > code');
    expect(code.getAttribute('class')).toBeNull();
    expect(executableFindings(html)).toEqual([]);
  });

  it('malformed VS Code metadata is ignored, the code still arrives', async () => {
    const html = await convertClipboard({ plain: 'let a = 1\nlet b = 2', html: '<div>let a = 1</div><div>let b = 2</div>', vscode: '{not json' });
    const code = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('pre > code');
    expect(code.textContent).toBe('let a = 1\nlet b = 2');
  });
});

describe('a ONE-LINE copy is inline text, never a code block', () => {
  // Chrome copies a fragment of one of our own code blocks as a single
  // monospace white-space:pre span — the shape of an editor clipboard.
  const chromeFragment = '<span style="font-family: ui-monospace, monospace; white-space: pre-wrap;">message</span>';
  it('a fragment of a rendered code block', () => {
    expect(editorClipboardAsCode('message', chromeFragment, null)).toBeNull();
  });
  it('a one-line VS Code copy', () => {
    expect(editorClipboardAsCode('let a = 1', '<div>let a = 1</div>', JSON.stringify({ mode: 'javascript' }))).toBeNull();
  });
  it('two lines from the same sources ARE code', () => {
    expect(editorClipboardAsCode('a = 1\nb = 2', '<span style="font-family: monospace; white-space: pre;">a = 1\nb = 2</span>', null)).toMatch(/^<pre><code>/);
  });
});
