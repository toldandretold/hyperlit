/**
 * @vitest-environment jsdom
 *
 * Code-block decoration (resources/js/codeBlocks/highlight.ts): header bar +
 * syntax colouring at render time. These pin the invariants the rest of the
 * app depends on: the node's TEXT never changes (hyperlight offsets, integrity
 * comparison), existing <mark>s survive colouring, and the language label is
 * honest (declared wins; auto-detection labels only when confident).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadHighlighter, REGISTERED_LANGUAGE_IDS } from '../../../resources/js/codeBlocks/hljsLoader';
import {
  decorateCodeBlocks, colourCodeBlock, uncolourCodeBlock, codeText,
  enterEditModeCodeBlocks, exitEditModeCodeBlocks, runsFromHighlightHtml,
} from '../../../resources/js/codeBlocks/highlight';
import { CODE_LANGUAGES } from '../../../resources/js/codeBlocks/language';

let hljs;
beforeAll(async () => { hljs = await loadHighlighter(); });

const PY = [
  'import os',
  'from pathlib import Path',
  '',
  'def read_lines(path: str) -> list[str]:',
  '    """Return the non-empty lines of a file."""',
  '    with open(path, "r", encoding="utf-8") as fh:',
  '        return [line.rstrip() for line in fh if line.strip()]',
  '',
  'class Counter:',
  '    def __init__(self):',
  '        self.total = 0',
  '',
  'if __name__ == "__main__":',
  '    print(read_lines(os.path.join("data", "input.txt")))',
].join('\n');

function block(text, cls) {
  const pre = document.createElement('pre');
  pre.id = '100';
  const code = document.createElement('code');
  if (cls) code.className = cls;
  code.textContent = text;
  pre.appendChild(code);
  const host = document.createElement('div');
  host.appendChild(pre);
  return { host, pre, code };
}

const label = (pre) => pre.querySelector('.code-block-lang')?.getAttribute('data-label');

describe('language registry', () => {
  it('every picker language is registered with the highlighter', () => {
    for (const lang of CODE_LANGUAGES) expect(REGISTERED_LANGUAGE_IDS).toContain(lang.id);
  });
});

describe('decorateCodeBlocks', () => {
  it('a declared language wins and is used for colouring', () => {
    const { host, pre } = block('const x = `hi ${name}`;', 'language-js');
    decorateCodeBlocks(host, { editing: false });
    expect(label(pre)).toBe('JavaScript');
    expect(pre.querySelector('span[data-code-tok].hljs-keyword')?.textContent).toBe('const');
  });

  it('auto-detects a substantial python block and labels it', () => {
    const { host, pre } = block(PY);
    decorateCodeBlocks(host, { editing: false });
    expect(pre.getAttribute('data-code-detected')).toBe('python');
    expect(label(pre)).toBe('Python');
  });

  it('a one-liner gets the neutral label even if colourable', () => {
    const { host, pre } = block('x = 1');
    decorateCodeBlocks(host, { editing: false });
    expect(label(pre)).toBe('Code');
  });

  it('a valid but unknown declared language is labelled honestly, not coloured', () => {
    const { host, pre } = block('main = putStrLn "hi"', 'language-haskell');
    decorateCodeBlocks(host, { editing: false });
    expect(label(pre)).toBe('Haskell');
    expect(pre.querySelector('span[data-code-tok]')).toBeNull();
  });

  it('drops a crafted language class instead of honouring it', () => {
    const { host, pre, code } = block('x', 'language-"><img');
    // classList can't hold a quote token via className parsing, so craft directly:
    code.setAttribute('class', 'language-a_b{} language-' + 'x'.repeat(40));
    decorateCodeBlocks(host, { editing: false });
    expect(code.getAttribute('class')).toBeNull();
    expect(label(pre)).toBe('Code');
  });

  it('NEVER changes the text, and the header adds no text nodes', () => {
    const { host, pre, code } = block(PY);
    const before = code.textContent;
    decorateCodeBlocks(host, { editing: false });
    expect(code.textContent).toBe(before);
    expect(pre.textContent).toBe(before); // header contributes nothing
    expect(codeText(pre)).toBe(before);
  });

  it('is idempotent', () => {
    const { host, pre } = block(PY);
    decorateCodeBlocks(host, { editing: false });
    const html = pre.innerHTML;
    decorateCodeBlocks(host, { editing: false });
    expect(pre.innerHTML).toBe(html);
    expect(pre.querySelectorAll('.code-block-header').length).toBe(1);
  });

  it('preserves an existing hyperlight <mark> spanning several tokens', () => {
    const { host, pre, code } = block('def f(a, b):\n    return a + b');
    // Mark "f(a, b)" — crosses a title token and punctuation.
    const t = code.firstChild;
    const r = document.createRange();
    r.setStart(t, 4); r.setEnd(t, 11);
    const mark = document.createElement('mark');
    mark.id = 'HL_1';
    r.surroundContents(mark);
    decorateCodeBlocks(host, { editing: false });
    const m = pre.querySelector('mark#HL_1');
    expect(m).not.toBeNull();
    expect(m.textContent).toBe('f(a, b)');
    expect(code.textContent).toBe('def f(a, b):\n    return a + b');
  });

  it('untokenises back to the exact original DOM text', () => {
    const { host, pre, code } = block(PY);
    decorateCodeBlocks(host, { editing: false });
    uncolourCodeBlock(pre);
    expect(code.querySelector('span')).toBeNull();
    expect(code.childNodes.length).toBe(1);
    expect(code.textContent).toBe(PY);
  });

  it('edit mode: header becomes a picker, no token spans; exit re-colours', () => {
    const { host, pre } = block(PY, 'language-python');
    decorateCodeBlocks(host, { editing: false });
    enterEditModeCodeBlocks(host);
    expect(pre.querySelector('span[data-code-tok]')).toBeNull();
    expect(pre.querySelector('[data-code-action="language"]')).not.toBeNull();
    exitEditModeCodeBlocks(host);
    expect(pre.querySelector('[data-code-action="language"]')).toBeNull();
    expect(pre.querySelector('span[data-code-tok]')).not.toBeNull();
  });

  it('a pre without a <code> child is decorated in place', () => {
    const pre = document.createElement('pre');
    pre.textContent = PY;
    const host = document.createElement('div');
    host.appendChild(pre);
    decorateCodeBlocks(host, { editing: false });
    expect(pre.textContent).toBe(PY);
    expect(pre.querySelector('span[data-code-tok]')).not.toBeNull();
  });
});

describe('security: code text renders inert', () => {
  it('markup in code text stays text after colouring (no live elements)', () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n<svg onload=alert(1)>';
    const { host, pre, code } = block(payload, 'language-html');
    decorateCodeBlocks(host, { editing: false });
    expect(code.textContent).toBe(payload);
    expect(pre.querySelector('img, script, svg:not(.code-block-header svg)')).toBeNull();
    for (const el of code.querySelectorAll('*')) {
      expect(el.tagName).toBe('SPAN');
      for (const a of el.attributes) expect(['class', 'data-code-tok']).toContain(a.name);
    }
    expect(window.__pwned).toBeUndefined();
  });

  it('refuses token boundaries whose text does not match the source', () => {
    expect(runsFromHighlightHtml('<span class="hljs-keyword">def</span>', 'def')).not.toBeNull();
    expect(runsFromHighlightHtml('<span class="hljs-keyword">dex</span>', 'def')).toBeNull();
    expect(runsFromHighlightHtml('&lt;b&gt;', '<b>')).not.toBeNull();
  });

  it('colourCodeBlock on a huge block does not tokenise (main-thread guard)', () => {
    const { pre } = block('x = 1\n'.repeat(20000));
    colourCodeBlock(pre, hljs);
    expect(pre.querySelector('span[data-code-tok]')).toBeNull();
  });
});
