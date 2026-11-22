/**
 * @vitest-environment jsdom
 *
 * Code-block decoration is RENDER-TIME ONLY. The save path
 * (processNodeContentHighlightsAndCites → stripCodeDecoration) must persist a
 * decorated block byte-identical to its undecorated original: no token spans
 * (spans never reach the DB), no header, no render-state attributes or `hljs`
 * class — while the `language-x` class, which IS content, survives. And
 * highlight positions measured on the decorated DOM must equal the plain ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadHighlighter } from '../../../resources/js/codeBlocks/hljsLoader';
import { decorateCodeBlocks, enterEditModeCodeBlocks } from '../../../resources/js/codeBlocks/highlight';
import { stripCodeDecoration } from '../../../resources/js/codeBlocks/stripDecoration';
import { processNodeContentHighlightsAndCites } from '../../../resources/js/indexedDB/nodes/contentProcessor';

beforeAll(async () => { await loadHighlighter(); });

const SRC = 'function add(a, b) {\n\treturn a + b; // sum\n}\n\nconst s = `${add(1, 2)} & <ok>`;';

function makePre(withMark = false) {
  const pre = document.createElement('pre');
  pre.id = '4200';
  pre.setAttribute('data-node-id', 'book_test_code1');
  const code = document.createElement('code');
  code.className = 'language-javascript';
  code.textContent = SRC;
  pre.appendChild(code);
  if (withMark) {
    const r = document.createRange();
    r.setStart(code.firstChild, 9);
    r.setEnd(code.firstChild, 30);
    const mark = document.createElement('mark');
    mark.id = 'HL_test';
    mark.className = 'HL_test';
    r.surroundContents(mark);
  }
  document.body.appendChild(pre);
  return pre;
}

describe('save path strips code decoration', () => {
  it('a decorated block saves identically to the undecorated original', () => {
    const plain = makePre();
    const expected = processNodeContentHighlightsAndCites(plain, []).content;
    plain.remove();

    const decorated = makePre();
    decorateCodeBlocks(decorated, { editing: false });
    expect(decorated.querySelector('span[data-code-tok]')).not.toBeNull();
    expect(decorated.querySelector('.code-block-header')).not.toBeNull();
    const saved = processNodeContentHighlightsAndCites(decorated, []).content;
    decorated.remove();

    expect(saved).toBe(expected);
    expect(saved).not.toMatch(/<span/);
    expect(saved).not.toMatch(/code-block|data-code|data-render-only|hljs|<button|<svg/);
    expect(saved).toContain('class="language-javascript"');
  });

  it('the edit-mode header (language picker) is stripped too', () => {
    const plain = makePre();
    const expected = processNodeContentHighlightsAndCites(plain, []).content;
    plain.remove();
    const pre = makePre();
    decorateCodeBlocks(pre, { editing: false });
    enterEditModeCodeBlocks(pre);
    expect(processNodeContentHighlightsAndCites(pre, []).content).toBe(expected);
    pre.remove();
  });

  it('hyperlight positions are the same on decorated and plain DOM', () => {
    const plain = makePre(true);
    const a = processNodeContentHighlightsAndCites(plain, []);
    plain.remove();
    const deco = makePre(true);
    decorateCodeBlocks(deco, { editing: false });
    const b = processNodeContentHighlightsAndCites(deco, []);
    deco.remove();
    expect(b.hyperlights).toEqual(a.hyperlights);
    expect(b.content).toBe(a.content);
  });

  it('unwraps foreign hljs spans pasted into a code block, keeps other spans elsewhere alone', () => {
    const host = document.createElement('div');
    host.innerHTML = '<pre><code class="hljs language-python"><span class="hljs-keyword">def</span> f(): <span class="hljs-title function_">pass</span></code></pre>';
    stripCodeDecoration(host);
    expect(host.innerHTML).toBe('<pre><code class="language-python">def f(): pass</code></pre>');
  });

  it('does not touch spans outside code blocks or spans with other attributes', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p><span class="hljs-keyword">x</span></p><pre><code><span id="keep" class="hljs-x">y</span></code></pre>';
    stripCodeDecoration(host);
    expect(host.querySelector('p span')).not.toBeNull();
    expect(host.querySelector('#keep')).not.toBeNull();
  });
});
