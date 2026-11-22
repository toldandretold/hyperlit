/**
 * @vitest-environment jsdom
 *
 * Pasted code must arrive EXACTLY as copied: one `<pre><code>` node whose
 * textContent equals the source byte for byte (indentation, tabs, blank lines,
 * `<` / `&` as literal characters), no markup inside the code, and a valid
 * language class when the clipboard declared one.
 *
 * Driven through the REAL paste stages (normalizer, format detection +
 * processors, marked + sanitizer, the large-paste block parser, the in-block
 * handler) in the order paste/index.ts handlePaste runs them. The one
 * deliberate normalisation: CRLF → LF, and a block carries no single trailing
 * newline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../resources/js/divEditor/index', () => ({ queueNodeForSave: vi.fn() }));

import { marked } from 'marked';
import { sanitizeHtml } from '../../../resources/js/utilities/sanitizeConfig';
import { detectFormat } from '../../../resources/js/paste/format-detection/format-detector';
import { getFormatConfig } from '../../../resources/js/paste/format-detection/format-registry';
import { detectMarkdown } from '../../../resources/js/paste/utils/markdown-detector';
import { preprocessMarkdownFootnotes, footnoteDefinitionsToHtml } from '../../../resources/js/paste/utils/markdown-processor';
import { estimatePasteNodeCount } from '../../../resources/js/paste/utils/dom-helpers';
import { stripMarkTags, stripHyperciteTags, convertDefinitionListTags, normalizeListItems } from '../../../resources/js/paste/utils/normalizer';
import { parseHtmlToBlocks } from '../../../resources/js/paste/utils/html-block-parser';
import {
  editorClipboardAsCode, rawHtmlSourceAsCode, normalizePastedCodeBlocks, VSCODE_MIME,
} from '../../../resources/js/paste/codePaste';
import { handleCodeBlockPaste } from '../../../resources/js/paste/handlers/codeBlockHandler';
import { queueNodeForSave } from '../../../resources/js/divEditor/index';

const ROOT = path.resolve(__dirname, '../../..');

/** Mirrors paste/index.ts handlePaste, steps 2–3 (clipboard → htmlContent). */
async function convertClipboard({ plain = '', html = '', vscode = null }) {
  let plainText = plain;
  let rawHtml = html;
  rawHtml = stripMarkTags(rawHtml);
  rawHtml = stripHyperciteTags(rawHtml);
  const editorCode = editorClipboardAsCode(plainText, rawHtml, vscode) ?? rawHtmlSourceAsCode(plainText, rawHtml);
  if (editorCode) { rawHtml = editorCode; plainText = ''; }
  rawHtml = normalizePastedCodeBlocks(rawHtml);

  let htmlContent = '';
  if (rawHtml.trim()) {
    const fmt = detectFormat(rawHtml);
    const config = getFormatConfig(fmt) ?? getFormatConfig('general');
    const processor = new config.processor();
    const result = estimatePasteNodeCount(rawHtml) <= 10
      ? await processor.processLite(rawHtml, 'book_paste_test')
      : await processor.process(rawHtml, 'book_paste_test');
    htmlContent = result.html;
  } else if (detectMarkdown(plainText)) {
    const { text, footnoteDefinitions } = preprocessMarkdownFootnotes(plainText);
    htmlContent = normalizeListItems(sanitizeHtml(marked(text) + footnoteDefinitionsToHtml(footnoteDefinitions)));
  }
  htmlContent = normalizePastedCodeBlocks(htmlContent);
  return convertDefinitionListTags(htmlContent);
}

function onlyCode(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const pres = doc.body.querySelectorAll('pre');
  expect(pres.length, `expected exactly one <pre> in: ${html.slice(0, 300)}`).toBe(1);
  const code = pres[0].querySelector(':scope > code');
  expect(code, 'pre > code').not.toBeNull();
  expect(code.children.length, `markup inside code: ${code.innerHTML.slice(0, 200)}`).toBe(0);
  return code;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- the samples ------------------------------------------------------------
const SAMPLES = {
  python: [
    'def greet(name: str, *args, **kwargs) -> None:',
    '    """Say hi to __name__ and _friends_."""',
    '',
    '    if name and not kwargs.get("quiet"):',
    "        print(f'hello {name}!')  # comment with `backticks`",
  ].join('\n'),
  javascript: [
    'const greet = (name) => {',
    '  const msg = `Hello, ${name} & <friends>`;',
    '  return msg.length > 3 && msg !== "x";',
    '};',
  ].join('\n'),
  typescript: 'function id<T>(x: T): T {\n  return x as unknown as T;\n}',
  php: '<?php\n$items = ["a" => 1];\necho "<b>" . htmlspecialchars($items["a"]) . "</b>";\n?>',
  html: '<!doctype html>\n<div class="card" onclick="go()">\n  <p>Tom &amp; Jerry &lt;3</p>\n</div>',
  json: '{\n  "name": "hyperlit",\n  "tags": ["a", "b"],\n  "nested": { "ok": true, "n": 1.5e3 }\n}',
  bash: 'for f in *.md; do\n  echo "$(wc -l < "$f") $f" && cat `ls` > out.txt 2>&1\ndone',
  sql: 'SELECT id, count(*) AS n -- tally\nFROM nodes\nWHERE book = \'x\' AND n > 2\nORDER BY n DESC;',
  yaml: 'services:\n  web:\n    image: "nginx:1.27"\n    ports:\n      - "80:80"\n\n  # db\n  db: {}',
  diff: '--- a/app.js\n+++ b/app.js\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;\n   unchanged();',
  latex: '\\begin{equation}\n  E = mc^2 % famous\n\\end{equation}\n\\textbf{bold} \\& \\_under',
  tabs: 'package main\n\nfunc main() {\n\tif true {\n\t\tprintln("tab-indented")\n\t}\n}',
};

const FENCE_LANG = { python: 'python', javascript: 'js', typescript: 'ts', php: 'php', html: 'html', json: 'json', bash: 'bash', sql: 'sql', yaml: 'yaml', diff: 'diff', latex: 'latex', tabs: 'go' };
const STORED_CLASS = { python: 'language-python', javascript: 'language-javascript', typescript: 'language-typescript', php: 'language-php', html: 'language-xml', json: 'language-json', bash: 'language-bash', sql: 'language-sql', yaml: 'language-yaml', diff: 'language-diff', latex: 'language-latex', tabs: 'language-go' };

function vscodeHtml(src) {
  const lines = src.split('\n').map((l) => (l === '' ? '<br>' : `<div><span style="color: #569cd6;">${esc(l)}</span></div>`)).join('');
  return `<meta charset='utf-8'><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Menlo, Monaco, 'Courier New', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;">${lines}</div>`;
}
function githubHtml(src, lang) {
  // GitHub's rendered markdown: highlight div carries the language, spans per token.
  const body = src.split('\n').map((l) => `<span class="pl-k">${esc(l)}</span>`).join('\n');
  return `<div class="highlight highlight-source-${lang} notranslate position-relative overflow-auto"><pre>${body}</pre></div>`;
}
function stackOverflowHtml(src, lang) {
  return `<pre class="lang-${lang} s-code-block"><code class="hljs language-${lang}"><span class="hljs-keyword">${esc(src)}</span></code></pre>`;
}
function brLinesHtml(src) {
  return `<pre><code>${src.split('\n').map(esc).join('<br>')}</code></pre>`;
}

// --- tests ------------------------------------------------------------------

describe('source gate: the paste pipeline never rewrites backticks', () => {
  it('no backtick → quote replacement in paste/index.ts', () => {
    const src = fs.readFileSync(path.join(ROOT, 'resources/js/paste/index.ts'), 'utf8');
    expect(src).not.toMatch(/\.replace\(\/`\/g/);
  });
});

describe.each(Object.entries(SAMPLES))('%s', (name, src) => {
  it('markdown fence WITH language → one code block, exact text, language class', async () => {
    const html = await convertClipboard({ plain: '```' + FENCE_LANG[name] + '\n' + src + '\n```' });
    const code = onlyCode(html);
    expect(code.textContent).toBe(src);
    expect(code.getAttribute('class')).toBe(STORED_CLASS[name]);
  });

  it('markdown fence WITHOUT language → one code block, exact text, no class', async () => {
    const html = await convertClipboard({ plain: '```\n' + src + '\n```' });
    const code = onlyCode(html);
    expect(code.textContent).toBe(src);
    expect(code.getAttribute('class')).toBeNull();
  });

  it('VS Code rich copy (with its metadata) → exact text + language', async () => {
    const html = await convertClipboard({ plain: src, html: vscodeHtml(src), vscode: JSON.stringify({ mode: FENCE_LANG[name] }) });
    const code = onlyCode(html);
    expect(code.textContent).toBe(src);
    expect(code.getAttribute('class')).toBe(STORED_CLASS[name]);
  });

  it('editor rich copy WITHOUT metadata (white-space:pre monospace div) → exact text', async () => {
    const html = await convertClipboard({ plain: src, html: vscodeHtml(src) });
    expect(onlyCode(html).textContent).toBe(src);
  });

  it('GitHub rendered code (highlight div + token spans) → exact text + language', async () => {
    const html = await convertClipboard({ plain: src, html: githubHtml(src, FENCE_LANG[name]) });
    const code = onlyCode(html);
    expect(code.textContent).toBe(src);
    expect(code.getAttribute('class')).toBe(STORED_CLASS[name]);
  });

  it('Stack Overflow / hljs docs site → exact text, hljs class dropped, language kept', async () => {
    const html = await convertClipboard({ plain: src, html: stackOverflowHtml(src, FENCE_LANG[name]) });
    const code = onlyCode(html);
    expect(code.textContent).toBe(src);
    expect(code.getAttribute('class')).toBe(STORED_CLASS[name]);
  });

  it('<br>-per-line code HTML → newlines as text, no <br> in the code', async () => {
    const html = await convertClipboard({ plain: src, html: brLinesHtml(src) });
    expect(onlyCode(html).textContent).toBe(src);
  });

  it('survives the large-paste block parser as one block', async () => {
    const html = await convertClipboard({ plain: '```' + FENCE_LANG[name] + '\n' + src + '\n```' });
    const blocks = parseHtmlToBlocks(html).filter((b) => /<pre/i.test(b));
    expect(blocks.length).toBe(1);
    expect(onlyCode(blocks[0]).textContent).toBe(src);
  });

  it('plain text pasted INTO an existing code block lands verbatim', () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    host.innerHTML = '<pre id="500"><code>AB</code></pre>';
    document.body.appendChild(host);
    const code = host.querySelector('code');
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(code.firstChild, 1);
    r.collapse(true);
    sel.addRange(r);

    let prevented = false;
    const event = {
      clipboardData: { getData: (t) => (t === 'text/plain' ? src : t === 'text/html' ? vscodeHtml(src) : '') },
      preventDefault: () => { prevented = true; },
    };
    expect(handleCodeBlockPaste(event, null, null)).toBe(true);
    expect(prevented).toBe(true);
    expect(code.textContent).toBe('A' + src + 'B');
    expect(code.children.length).toBe(0);
    expect(queueNodeForSave).toHaveBeenCalledWith('500', 'update', null);
    host.remove();
  });
});

describe('newline policy and edge cases', () => {
  it('CRLF from Windows clipboards becomes LF, inside a block too', () => {
    const host = document.createElement('div');
    host.innerHTML = '<pre id="501"><code></code></pre>';
    document.body.appendChild(host);
    const code = host.querySelector('code');
    const r = document.createRange();
    r.selectNodeContents(code);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    handleCodeBlockPaste({ clipboardData: { getData: () => 'a\r\nb\rc' }, preventDefault() {} }, null, null);
    expect(code.textContent).toBe('a\nb\nc');
    host.remove();
  });

  it('a selection that straddles out of the code block is NOT a code-block paste', () => {
    const host = document.createElement('div');
    host.innerHTML = '<pre id="502"><code>code</code></pre><p id="503">prose</p>';
    document.body.appendChild(host);
    const r = document.createRange();
    r.setStart(host.querySelector('code').firstChild, 2);
    r.setEnd(host.querySelector('p').firstChild, 2);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    expect(handleCodeBlockPaste({ clipboardData: { getData: () => 'x' }, preventDefault() {} }, null, null)).toBe(false);
    host.remove();
  });

  it('a caret on the <pre> boundary (after the header) still inserts inside <code>', () => {
    const host = document.createElement('div');
    host.innerHTML = '<pre id="504"><span data-render-only="code-header" contenteditable="false"></span><code>xy</code></pre>';
    document.body.appendChild(host);
    const pre = host.querySelector('pre');
    const r = document.createRange();
    r.setStart(pre, 1); // between header and code
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    handleCodeBlockPaste({ clipboardData: { getData: () => 'Z' }, preventDefault() {} }, null, null);
    expect(host.querySelector('code').textContent).toBe('xyZ');
    expect(host.querySelector('[data-render-only]').textContent).toBe('');
    host.remove();
  });

  it('smart quotes in code are kept as copied', async () => {
    const src = 'print(“hi”) # it’s';
    const code = onlyCode(await convertClipboard({ plain: '```python\n' + src + '\n```' }));
    expect(code.textContent).toBe(src);
  });

  it('prose around a fence still converts; the fence is one block', async () => {
    const html = await convertClipboard({ plain: 'Some **bold** intro.\n\n```js\nlet a = `x`;\n```\n\nAfter.' });
    expect(onlyCode(html).textContent).toBe('let a = `x`;');
    expect(html).toMatch(/<strong>bold<\/strong>/);
  });

  it('pasting raw HTML source (escaped html side) becomes code, not markup', async () => {
    const src = '<section>\n  <h2>Title</h2>\n</section>';
    const html = await convertClipboard({ plain: src, html: `<span>${esc(src)}</span>` });
    expect(onlyCode(html).textContent).toBe(src);
  });

  it('VS Code clipboard metadata is read under its real MIME name', () => {
    expect(VSCODE_MIME).toBe('vscode-editor-data');
  });
});
