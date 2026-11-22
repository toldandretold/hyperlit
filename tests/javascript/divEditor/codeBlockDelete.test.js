/**
 * Backspace at the start / Delete at the end of a code block. The block's
 * first child is a contenteditable=false header; native Backspace deleted IT
 * instead of joining two code blocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queued = [];
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave: (id, action) => queued.push([id, action]) }));

import { handleCodeBlockDelete } from '../../../resources/js/divEditor/keydownGuards/codeBlockDelete';

const HEADER = '<span class="code-block-header" data-render-only="code-header" contenteditable="false"><button data-code-action="copy"></button></span>';

function build(html) {
  document.body.innerHTML = `<div contenteditable="true" class="main-content"><div class="chunk">${html}</div></div>`;
}
const key = (k) => ({ key: k, preventDefault: vi.fn() });
function caret(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  return r;
}

beforeEach(() => { queued.length = 0; });

describe('code block Backspace / Delete', () => {
  it('Backspace at the start joins into the code block above; header kept, mark kept', () => {
    build(`<pre id="100">${HEADER}<code class="language-python">a = 1\n</code></pre><pre id="200">${HEADER}<code>b = <mark id="HL_1">2</mark></code></pre>`);
    const mark = document.getElementById('HL_1');
    const e = key('Backspace');
    expect(handleCodeBlockDelete(e, caret(document.querySelector('pre[id="200"] code').firstChild, 0))).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.querySelectorAll('pre').length).toBe(1);
    const code = document.querySelector('pre[id="100"] code');
    expect(code.textContent).toBe('a = 1\nb = 2');
    expect(code.getAttribute('class')).toBe('language-python');
    expect(document.querySelector('pre[id="100"] .code-block-header')).not.toBeNull();
    expect(code.querySelector('#HL_1')).toBe(mark);
    expect(queued).toEqual([['200', 'delete'], ['100', 'update']]);
    // Caret at the seam.
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(code, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    expect(r.toString()).toBe('a = 1');
  });

  it('Delete at the end joins the code block below up', () => {
    build(`<pre id="100">${HEADER}<code>a = 1</code></pre><pre id="200">${HEADER}<code>b = 2</code></pre>`);
    const t = document.querySelector('pre[id="100"] code').firstChild;
    expect(handleCodeBlockDelete(key('Delete'), caret(t, t.data.length))).toBe(true);
    expect(document.querySelector('pre[id="100"] code').textContent).toBe('a = 1\nb = 2');
    expect(document.getElementById('200')).toBeNull();
  });

  it('Backspace at the start of an EMPTY code block turns it into an empty paragraph (same identity)', () => {
    build(`<p id="50">x</p><pre id="100" data-node-id="n1">${HEADER}<code></code></pre>`);
    const code = document.querySelector('pre[id="100"] code');
    expect(handleCodeBlockDelete(key('Backspace'), caret(code, 0))).toBe(true);
    const p = document.getElementById('100');
    expect(p.tagName).toBe('P');
    expect(p.getAttribute('data-node-id')).toBe('n1');
  });

  it('Backspace at the start after a PARAGRAPH destroys nothing: caret moves up, header survives', () => {
    build(`<p id="50">intro</p><pre id="100">${HEADER}<code>a = 1</code></pre>`);
    expect(handleCodeBlockDelete(key('Backspace'), caret(document.querySelector('pre[id="100"] code').firstChild, 0))).toBe(true);
    expect(document.querySelector('pre[id="100"] .code-block-header')).not.toBeNull();
    expect(document.querySelector('pre[id="100"] code').textContent).toBe('a = 1');
    expect(window.getSelection().anchorNode.textContent).toBe('intro');
  });

  it('mid-text Backspace and Delete are left to the browser', () => {
    build(`<pre id="100">${HEADER}<code>a = 1</code></pre><pre id="200">${HEADER}<code>b</code></pre>`);
    const t = document.querySelector('pre[id="100"] code').firstChild;
    expect(handleCodeBlockDelete(key('Backspace'), caret(t, 2))).toBe(false);
    expect(handleCodeBlockDelete(key('Delete'), caret(t, 2))).toBe(false);
  });
});
